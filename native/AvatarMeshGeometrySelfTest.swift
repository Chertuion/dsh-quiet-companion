import Foundation

/// Pure geometry only: no NSApplication, SKView, speech, microphone or capture.
@main
struct AvatarMeshGeometrySelfTest {
    static func main() {
        func check(_ value: @autoclosure () -> Bool, _ message: String) {
            if !value() { fatalError(message) }
        }
        func close(_ a: CGPoint, _ b: CGPoint, _ epsilon: CGFloat = 1e-6) -> Bool {
            hypot(a.x - b.x, a.y - b.y) < epsilon
        }
        check(AvatarMeshMotionProfile.actions.count == 24, "24 semantic profiles required")
        check(AvatarMeshGeometry(mouthRect: [0.4, 0.3, 0.5, 0.2]).mouthRect == nil, "oversized mouth rejected")
        check(AvatarMeshGeometry(mouthRect: [0.4, .nan, 0.04, 0.02]).mouthRect == nil, "non-finite mouth rejected")
        check(AvatarMeshGrid.imageRect(imageSize: CGSize(width: CGFloat.infinity, height: 100), viewport: CGSize(width: 200, height: 200)) == .zero,
              "invalid image dimensions rejected")
        let geometry = AvatarMeshGeometry(mouthRect: [0.47, 0.34, 0.06, 0.026], headRect: [0.17, 0.03, 0.66, 0.43])
        let anchor = CGPoint(x: geometry.mouthRect!.midX, y: geometry.mouthRect!.midY)
        var roundTrips = 0, cells = 0, distinct = Set<String>()
        for name in AvatarMeshMotionProfile.actions.keys.sorted() {
            let profile = AvatarMeshMotionProfile.named(name)
            distinct.insert("\(profile.breath),\(profile.head),\(profile.hair),\(profile.period)")
            for time in [0.0, 0.23, 1.1, 2.8, 8.3, 51.9] {
                let grid = AvatarMeshGrid.make(profile: profile, time: time, geometry: geometry, enabled: true)
                check(grid.maximumDisplacement < 0.02, "small displacements only")
                for row in 0..<AvatarMeshGrid.rows {
                    for col in 0..<AvatarMeshGrid.columns {
                        let i = row * (AvatarMeshGrid.columns + 1) + col
                        let a = grid.destination[i], b = grid.destination[i + 1]
                        let c = grid.destination[i + AvatarMeshGrid.columns + 1]
                        let d = grid.destination[i + AvatarMeshGrid.columns + 2]
                        check(close(d, CGPoint(x: b.x + c.x - a.x, y: b.y + c.y - a.y), 1e-10), "cells must be affine")
                        check((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0, "no inverted cells")
                        cells += 1
                    }
                }
                for index in 0...100 {
                    let p = CGPoint(x: CGFloat(index) / 100, y: CGFloat((index * 37) % 101) / 100)
                    let warped = grid.forward(p)!
                    check(close(grid.inverse(warped)!, p), "mesh inverse round trip")
                    roundTrips += 1
                }
                for size in [CGSize(width: 280, height: 270), CGSize(width: 168, height: 162), CGSize(width: 448, height: 432)] {
                    let fit = AvatarMeshGrid.imageRect(imageSize: CGSize(width: 512, height: 700), viewport: size)
                    let mouth = grid.scenePoint(for: anchor, imageRect: fit)!
                    check(close(grid.originalPoint(for: mouth, imageRect: fit)!, anchor), "mouth follows same forward/inverse grid")
                    check(grid.originalPoint(for: CGPoint(x: -1000, y: -1000), imageRect: fit) == nil, "outside hit is nil")
                    roundTrips += 1
                }
            }
            let frozen = AvatarMeshGrid.make(profile: profile, time: 99, geometry: geometry, enabled: false)
            check(frozen.source == frozen.destination, "disabled/reduced/hidden geometry is identity")
        }
        check(distinct.count == 24, "semantic profiles have distinct parameter sets")
        let first = AvatarMeshGrid.make(profile: .named("idle"), time: 0.5, geometry: geometry, enabled: true)
        let later = AvatarMeshGrid.make(profile: .named("idle"), time: 1.0, geometry: geometry, enabled: true)
        check(first.destination != later.destination, "time changes real vertices")
        check(first.forward(CGPoint(x: .infinity, y: 0.5)) == nil, "invalid point rejected")
        print("Avatar mesh pure geometry PASS: 24 profiles; \(cells) affine nonfolded cells; \(roundTrips) inverse/mouth round trips; disabled identity.")
    }
}
