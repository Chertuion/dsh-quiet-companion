/**
 * MIT — Copyright (c) 2026 roleplay-plugin contributors.
 * Source: ajuwm/dsh-roleplay-plugin, commit c2f4844e8e342c9a0079b7d4df419adb774bccef.
 * https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L178-L185
 * https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L1337-L1349
 * https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/lib/relation-core.mjs
 * Full license: ./ROLEPLAY-GROWTH-LICENSE.txt.
 *
 * Adaptation: extract only food values/restoration and pure relationship helpers.
 * applyFood is a new immutable wrapper around the original satiety/mood/health
 * effects. Original price is retained solely as food-quality metadata; this
 * module performs no purchases or currency operations. No mortality, absence
 * penalty, Host hooks, timers, filesystem/network access or Windows code is used.
 * This file is not upstream's similarly named minigame module.
 */

export const foodCatalog = Object.freeze([
  Object.freeze({ id: 'mantou', name: '馒头', kind: 'food', price: 10, satiety: 10, mood: 1 }),
  Object.freeze({ id: 'lamian', name: '一碗拉面', kind: 'food', price: 25, satiety: 14, mood: 2 }),
  Object.freeze({ id: 'dianxin', name: '精致点心', kind: 'food', price: 40, satiety: 18, mood: 4 }),
  Object.freeze({ id: 'cake', name: '橡木蛋糕卷', kind: 'food', price: 60, satiety: 25, mood: 5 }),
]);

const bounded=(value,fallback)=>Number.isFinite(value)?Math.max(0,Math.min(100,value)):fallback;

/** Original food restoration rule, wrapped as a pure immutable state update. */
export function applyFood(stats={},foodId) {
  const item=foodCatalog.find(food=>food.id===foodId);
  if(!item) return {...stats};
  const satiety=bounded(stats.satiety,75),mood=bounded(stats.mood,70),health=bounded(stats.health,85);
  const heal=item.price>=40?2:1;
  return {...stats,satiety:Math.min(100,satiety+item.satiety),
    mood:Math.min(100,mood+item.mood),health:Math.min(100,health+heal)};
}

// Original pure relationship helpers, unchanged.
export function axisTier(v) { return v <= 33 ? 1 : v <= 66 ? 2 : 3 }
export function repeatDimOf(recent, axis, dir) {
  if (!dir) return 1
  const arr = Array.isArray(recent) ? recent : []
  let n = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i]
    if (e && e.decay) return 1
    const v = e && typeof e[axis] === 'number' ? e[axis] : 0
    if (v === 0) continue
    if ((v > 0 ? 1 : -1) !== dir) break
    n++
  }
  if (n === 0) return 1
  if (n === 1) return 0.6
  return 0.3
}
