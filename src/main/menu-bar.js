'use strict';

function highestUsage(snapshot) {
  const values = (snapshot?.buckets || []).map((bucket) => bucket.usedPercent).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

/**
 * The tightest limit, because that is the one that blocks usage first. A "~"
 * marks a last-known value and "–" means nothing has been fetched yet.
 */
function formatMenuBarTitle(snapshot) {
  if (!snapshot || snapshot.status === 'disabled') return '';
  const highest = highestUsage(snapshot);
  if (highest === null) return '–';
  return `${snapshot.stale ? '~' : ''}${Math.round(highest)}%`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function popoverBounds(trayBounds, workArea, size, margin = 6) {
  const width = Math.min(size.width, workArea.width - margin * 2);
  const height = Math.min(size.height, workArea.height - margin * 2);
  const right = workArea.x + workArea.width - width - margin;
  if (!trayBounds || !(trayBounds.width > 0) || !(trayBounds.height > 0)) {
    return { x: right, y: workArea.y + margin, width, height };
  }
  const x = clamp(Math.round(trayBounds.x + trayBounds.width / 2 - width / 2), workArea.x + margin, right);
  const trayAtTop = trayBounds.y + trayBounds.height / 2 < workArea.y + workArea.height / 2;
  const y = trayAtTop
    ? Math.max(workArea.y, trayBounds.y + trayBounds.height) + margin
    : Math.min(workArea.y + workArea.height, trayBounds.y) - height - margin;
  return {
    x,
    y: clamp(Math.round(y), workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

module.exports = { formatMenuBarTitle, highestUsage, popoverBounds };
