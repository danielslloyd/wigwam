// Arrow-key ("D-pad") navigation so the app works with a TV remote or keyboard.
// Arrows move focus to the nearest focusable element in that direction;
// Escape / Backspace / remote Back call onBack().

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  && !el.closest('[inert], .hidden');

function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

export function moveFocus(root, dir) {
  const current = document.activeElement;
  const items = [...root.querySelectorAll(FOCUSABLE)].filter(visible);
  if (!items.length) return false;
  if (!items.includes(current)) { items[0].focus(); return true; }

  const r = current.getBoundingClientRect(), c = center(r);
  let best = null, bestScore = Infinity;
  for (const el of items) {
    if (el === current) continue;
    const r2 = el.getBoundingClientRect(), c2 = center(r2);
    const dx = c2.x - c.x, dy = c2.y - c.y;
    let main, cross;
    if (dir === 'right') { main = dx; cross = Math.abs(dy); }
    else if (dir === 'left') { main = -dx; cross = Math.abs(dy); }
    else if (dir === 'down') { main = dy; cross = Math.abs(dx); }
    else { main = -dy; cross = Math.abs(dx); }
    if (main <= 4) continue;
    const score = main + cross * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  best.focus({ preventScroll: true });
  best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  return true;
}

export function initSpatialNav(root, { onBack }) {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const a = document.activeElement;
    const typing = a && ((a.tagName === 'INPUT' && a.type !== 'range') || a.tagName === 'TEXTAREA');

    if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
      e.preventDefault();
      onBack();
      return;
    }
    const dir = DIRS[e.key];
    if (!dir) return;
    if ((typing || a?.type === 'range') && (dir === 'left' || dir === 'right')) return; // let the field handle it
    if (moveFocus(root, dir)) e.preventDefault();
  });
}
