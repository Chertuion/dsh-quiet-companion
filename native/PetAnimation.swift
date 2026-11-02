import AppKit
import ImageIO

/// Timed Q-character poses; continuous vertex motion is rendered independently.
/// Frame durations follow a monotonic clock, not the arrival of Host snapshots.
final class PetAnimationPlayer {
    static let expectedCharacterID = "orange-q-companion"
    static let requiredClips = MotionAction.allCases.map(\.rawValue)
    private struct Frame: Decodable {
        let sheet: String
        let row: Int
        let column: Int
        let durationMs: Double?
        let mouth: [Double]?
    }
    private struct Clip: Decodable {
        let frames: [Frame]
        let frameMs: Double
        let loop: Bool
    }
    private struct Manifest: Decodable {
        let schemaVersion: Int
        let characterId: String
        let columns: Int
        let rows: Int
        let sheets: [String:String]
        let clips: [String:Clip]
        let hitRegions: [String:[Double]]?
        let anchors: [String:[Double]]?
        let staticMouths: [String:[Double]]?
    }
    private let root: URL
    private let manifest: Manifest?
    private let onFrame: (NSImage)->Void
    private var timer: Timer?
    private var frameIndex = 0
    private var clipStarted = 0.0
    private var stopped = false
    private var reduced = false
    private var context = MotionContext()
    private var decoded: [Int:NSImage] = [:]
    private var cacheOrder: [Int] = []
    private var sheetImages: [String:CGImage] = [:]
    private var sheetOrder: [String] = []
    private var sheetBytes = 0
    private var idleCycles = 0
    private(set) var currentClip = ""
    var available: Bool { manifest != nil }
    var characterID: String? { manifest?.characterId }
    var clipCount: Int { manifest?.clips.count ?? 0 }
    var frameCount: Int { manifest?.clips.values.reduce(0) { $0+$1.frames.count } ?? 0 }
    var currentMouthRect: [Double]? { manifest?.clips[currentClip]?.frames[safe:frameIndex]?.mouth }
    func staticMouthRect(_ name:String)->[Double]? { manifest?.staticMouths?[name] }
    var mouthAnchor: CGPoint {
        if let rect=currentMouthRect, rect.count==4 { return CGPoint(x:rect[0]+rect[2]/2,y:rect[1]+rect[3]/2) }
        let point=manifest?.anchors?["mouth"] ?? [0.5,0.44]
        return CGPoint(x:point[0],y:point[1])
    }
    init(root:URL,onFrame:@escaping(NSImage)->Void) {
        self.root=root;self.onFrame=onFrame
        if let data=try? Data(contentsOf:root.appendingPathComponent("pet-manifest.json")),
           let value=try? JSONDecoder().decode(Manifest.self,from:data),
           Self.validate(value,root:root) {manifest=value}else{manifest=nil}
    }
    private static func safeURL(_ path:String,root:URL)->URL? {
        guard !path.hasPrefix("/"),!path.split(separator:"/").contains(".."),path.lowercased().hasSuffix(".png") else{return nil}
        let url=root.appendingPathComponent(path).resolvingSymlinksInPath()
        return url.path.hasPrefix(root.resolvingSymlinksInPath().path+"/") ? url:nil
    }
    private static func pngSize(_ url:URL)->(Int,Int)? {
        guard let source=CGImageSourceCreateWithURL(url as CFURL,nil),
              CGImageSourceGetType(source) as String? == "public.png",
              let p=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
              let w=p[kCGImagePropertyPixelWidth] as? Int,let h=p[kCGImagePropertyPixelHeight] as? Int,
              w>0,h>0,w<=4096,h<=4096 else{return nil}
        return (w,h)
    }
    private static func validRect(_ a:[Double],mouth:Bool=false)->Bool {
        a.count==4 && a.allSatisfy{$0.isFinite && $0>=0 && $0<=1}
        && a[2]>0 && a[3]>0 && a[0]+a[2]<=1 && a[1]+a[3]<=1
        && (!mouth || a[2]<=0.12 && a[3]<=0.075)
    }
    private static func validate(_ m:Manifest,root:URL)->Bool {
        guard m.schemaVersion==3,m.characterId==expectedCharacterID,m.columns==4,m.rows==4,
              !m.sheets.isEmpty,m.sheets.count<=32,m.clips.count<=64,m.clips["tail"]==nil,
              requiredClips.allSatisfy({m.clips[$0] != nil}) else{return false}
        for path in m.sheets.values {
            guard let url=safeURL(path,root:root),let size=pngSize(url),size.0>=4,size.1>=4 else{return false}
        }
        for clip in m.clips.values {
            guard (1...64).contains(clip.frames.count),clip.frameMs.isFinite,(16...5000).contains(clip.frameMs) else{return false}
            var total=0.0
            for f in clip.frames {
                let duration=f.durationMs ?? clip.frameMs
                guard m.sheets[f.sheet] != nil,(0..<4).contains(f.row),(0..<4).contains(f.column),
                      duration.isFinite,(16...5000).contains(duration) else{return false}
                if let mouth=f.mouth,!validRect(mouth,mouth:true){return false}
                total+=duration
            }
            guard total<=120000 else{return false}
        }
        for name in ["idle.png","shy.png"] {
            guard let url=safeURL(name,root:root),pngSize(url) != nil else{return false}
        }
        for (name,rect) in m.hitRegions ?? [:] {
            guard ["head","body","skirt"].contains(name),validRect(rect) else{return false}
        }
        for point in (m.anchors ?? [:]).values {
            guard point.count==2,point.allSatisfy({$0.isFinite && $0>=0 && $0<=1}) else{return false}
        }
        guard m.staticMouths?["idle"] != nil,m.staticMouths?["shy"] != nil else{return false}
        for (key,rect) in m.staticMouths ?? [:] {
            guard ["idle","shy"].contains(key),validRect(rect,mouth:true) else{return false}
        }
        return true
    }
    func firstFrameDecodes()->Bool {decodeFrame(at:0,clip:"idle") != nil}
    func allFramesDecode()->Bool {
        guard let m=manifest else{return false}
        for (name,clip) in m.clips {
            for i in clip.frames.indices {
                guard let image=decodeFrame(at:i,clip:name),image.width>0,image.height>0 else{return false}
            }
        }
        return true
    }
    func interactionRegion(at p:CGPoint)->String {
        let defaults=["head":[0.10,0.02,0.80,0.50],"body":[0.18,0.52,0.64,0.22],"skirt":[0.12,0.74,0.76,0.24]]
        for kind in ["head","body","skirt"] {
            let r=manifest?.hitRegions?[kind] ?? defaults[kind]!
            if CGRect(x:r[0],y:r[1],width:r[2],height:r[3]).contains(p){return kind}
        }
        return p.y>=0.74 ? "skirt":"body"
    }
    private func sheet(_ key:String)->CGImage? {
        guard let m=manifest,let path=m.sheets[key] else{return nil}
        if let cached=sheetImages[key] {
            sheetOrder.removeAll{$0==key};sheetOrder.append(key);return cached
        }
        guard let url=Self.safeURL(path,root:root),let source=CGImageSourceCreateWithURL(url as CFURL,nil),
              let image=CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary) else{return nil}
        let cost=image.bytesPerRow*image.height
        while !sheetOrder.isEmpty && (sheetImages.count>=4 || sheetBytes+cost>64*1024*1024) {
            let key=sheetOrder.removeFirst()
            if let image=sheetImages.removeValue(forKey:key){sheetBytes-=image.bytesPerRow*image.height}
        }
        sheetImages[key]=image;sheetOrder.append(key);sheetBytes+=cost
        return image
    }
    private func decodeFrame(at i:Int,clip name:String)->CGImage? {
        guard let m=manifest,let f=m.clips[name]?.frames[safe:i],let image=sheet(f.sheet) else{return nil}
        let x=f.column*image.width/m.columns,y=f.row*image.height/m.rows
        let right=(f.column+1)*image.width/m.columns,bottom=(f.row+1)*image.height/m.rows
        return image.cropping(to:CGRect(x:x,y:y,width:right-x,height:bottom-y))
    }
    private func image(at i:Int,clip name:String)->NSImage? {
        if name==currentClip,let value=decoded[i]{return value}
        guard let image=decodeFrame(at:i,clip:name) else{return nil}
        // Common logical square avoids pixel-size rounding jumps across generated sheets.
        let result=NSImage(cgImage:image,size:NSSize(width:512,height:512))
        if name==currentClip {
            decoded[i]=result;cacheOrder.append(i)
            while cacheOrder.count>12 {decoded.removeValue(forKey:cacheOrder.removeFirst())}
        }
        return result
    }
    func setState(_ phase:String,activity:String="") {
        context.agentPhase=phase;context.activity=activity;reconcile()
    }
    func setThinking(_ value:Bool){context.modelPending=value;reconcile()}
    func setSleeping(_ value:Bool){context.sleeping=value;reconcile()}
    func setSpeaking(_ value:Bool){
        context.speaking=value
        if value {context.temporaryAction=nil;context.idleAction=nil}
        reconcile()
    }
    func mood(_ value:String){context.mood=value;reconcile()}
    func interaction(_ kind:String) {
        context=context.applyingInteraction(kind)
        reconcile(force:true)
    }
    private func reconcile(force:Bool=false) {
        guard !stopped else{return}
        let key=context.resolve()
        // An unchanged finite action may hold its final pose, never restart per snapshot.
        if !force,key==currentClip{return}
        play(key)
    }
    private func play(_ name:String) {
        guard let clip=manifest?.clips[name],!clip.frames.isEmpty else{return}
        timer?.invalidate();timer=nil
        currentClip=name;frameIndex=0;clipStarted=ProcessInfo.processInfo.systemUptime
        decoded.removeAll(keepingCapacity:true);cacheOrder.removeAll(keepingCapacity:true)
        if let frame=image(at:0,clip:name){onFrame(frame)}
        guard !stopped else{return}
        if reduced {scheduleFrozenCompletion(clip);return}
        timer=Timer.scheduledTimer(withTimeInterval:1.0/30.0,repeats:true){[weak self] _ in self?.advance()}
    }
    private func advance() {
        guard let clip=manifest?.clips[currentClip] else{return}
        let durations=clip.frames.map{($0.durationMs ?? clip.frameMs)/1000}
        let total=durations.reduce(0,+),elapsed=max(0,ProcessInfo.processInfo.systemUptime-clipStarted)
        var local=elapsed
        if elapsed>=total {
            if clip.loop {
                let loops=Int(elapsed/total)
                clipStarted+=Double(loops)*total;local=elapsed-Double(loops)*total
                if currentClip=="idle",context.resolve()=="idle" {
                    idleCycles+=loops
                    if idleCycles>=2 {
                        context.idleAction=idleCycles>=6 ? "wave":"idle_look"
                        if idleCycles>=6{idleCycles=0}
                        reconcile();return
                    }
                }
            } else {
                if frameIndex != clip.frames.count-1 {
                    frameIndex=clip.frames.count-1
                    if let frame=image(at:frameIndex,clip:currentClip){onFrame(frame)}
                }
                timer?.invalidate();timer=nil
                if context.temporaryAction != nil {
                    context=context.finishingTemporaryAction();reconcile()
                } else if context.idleAction != nil {
                    context.idleAction=nil;reconcile()
                }
                return
            }
        }
        var edge=0.0,index=durations.count-1
        for (i,d) in durations.enumerated(){edge+=d;if local<edge{index=i;break}}
        guard index != frameIndex else{return}
        frameIndex=index
        if let frame=image(at:index,clip:currentClip){onFrame(frame)}
    }
    private func scheduleFrozenCompletion(_ clip:Clip) {
        guard context.temporaryAction != nil || context.idleAction != nil else{return}
        let duration=clip.frames.reduce(0.0){$0+($1.durationMs ?? clip.frameMs)/1000}
        let remaining=max(0.016,duration-max(0,ProcessInfo.processInfo.systemUptime-clipStarted))
        timer=Timer.scheduledTimer(withTimeInterval:remaining,repeats:false){[weak self] _ in
            guard let self,!self.stopped else{return}
            self.timer=nil
            if self.context.temporaryAction != nil {self.context=self.context.finishingTemporaryAction()}
            self.context.idleAction=nil
            self.reconcile()
        }
    }
    func setReducedMotion(_ value:Bool) {
        guard reduced != value else{return}
        reduced=value
        if value {
            timer?.invalidate();timer=nil;frameIndex=0
            if let frame=image(at:0,clip:currentClip){onFrame(frame)}
            if let clip=manifest?.clips[currentClip],!stopped {scheduleFrozenCompletion(clip)}
        }else if !stopped{play(context.resolve())}
    }
    func stop() {stopped=true;timer?.invalidate();timer=nil;decoded.removeAll();cacheOrder.removeAll()}
    func resume(){stopped=false;play(context.resolve())}
    deinit{timer?.invalidate()}
}
private extension Array {
    subscript(safe index:Int)->Element? {indices.contains(index) ? self[index]:nil}
}
