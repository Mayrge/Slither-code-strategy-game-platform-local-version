import { COLORS } from './engine.js';
import starterDecide from '../strategies/starter.js';

export const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
export const starterSource = '// 自定义策略：可修改此代码，或导入 AI 生成的 strategy.js。\nexport default ' + starterDecide.toString() + '\n';

// Keep the original storage key so previously saved strategy edits are retained.
export function restorePlayers(saved, templates) {
  if (!Array.isArray(saved) || saved.length < 2 ||
      new Set(saved.map(p => p?.id)).size !== saved.length ||
      saved.filter(p => p?.enabled).length < 2 || saved.filter(p => p?.enabled).length > 10) return null;
  if (!saved.every(p => p && Number.isSafeInteger(p.id) && p.id > 0 && p.id < Number.MAX_SAFE_INTEGER &&
      typeof p.name === 'string' && p.name.length <= 24 &&
      typeof p.role === 'string' && p.role.length <= 24 &&
      typeof p.source === 'string' && p.source.length <= 200000 &&
      typeof p.enabled === 'boolean' && (p.color == null || validColor(p.color)))) return null;
  return saved.map(p => ({ id: p.id, name: p.name, role: p.role, source: p.source, enabled: p.enabled, ...(typeof p.registrationId === 'string' ? { registrationId: p.registrationId } : {}),
    color: p.color || templates.find(t => t.id === p.id)?.color || COLORS[(p.id - 1) % COLORS.length] }));
}

export function createPlayer(players) {
  const id = Math.max(0, ...players.map(p => p.id)) + 1;
  const usedColors = new Set(players.map(p => p.color.toLowerCase()));
  const color = COLORS.find(c => !usedColors.has(c)) || '#66ccff';
  return { id, name: `自定义选手 ${id}`, role: '自定义策略', color, source: starterSource,
    enabled: players.filter(p => p.enabled).length < 10 };
}
