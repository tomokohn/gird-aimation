/**
 * Grid Animation — FLIP technique
 *
 * FLIP = First → Last → Invert → Play
 *
 * How it works:
 *   1. FIRST  – snapshot every child's position before the DOM change
 *   2. LAST   – after the DOM change, read the new positions
 *   3. INVERT – apply a transform that visually puts each child back at its old spot
 *   4. PLAY   – animate that transform back to zero (identity), so the element
 *               appears to glide from old → new position
 *
 * Usage:
 *   const { unwrapGrid, forceGridAnimation } = wrapGrid(containerElement, {
 *     duration : 300,   // ms
 *     stagger  : 0,     // ms delay multiplied by child index
 *     easing   : 'easeInOut',
 *     onStart  : (movedItems) => {},
 *     onEnd    : (movedItems) => {},
 *   });
 */

// ---------------------------------------------------------------------------
// Easing functions (t is 0→1, output is 0→1)
// ---------------------------------------------------------------------------
const EASINGS = {
  linear     : t => t,
  easeIn     : t => t * t,
  easeOut    : t => t * (2 - t),
  easeInOut  : t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  backIn     : t => t * t * (2.7 * t - 1.7),
  backOut    : t => --t * t * (2.7 * t + 1.7) + 1,
  backInOut  : t => (t *= 2) < 1
                     ? 0.5 * t * t * (3.7 * t - 2.7)
                     : 0.5 * ((t -= 2) * t * (3.7 * t + 2.7) + 2),
  anticipate : t => (t *= 2) < 1
                     ? 0.5 * t * t * ((1.525 + 1) * t - 1.525)
                     : 0.5 * ((t -= 2) * t * ((1.525 + 1) * t + 1.525) + 2),
};

// ---------------------------------------------------------------------------
// Unique ID bookkeeping
// ---------------------------------------------------------------------------
const GRID_ID_ATTR = 'data-grid-anim-id';
let nextId = 1;

function ensureId(el) {
  if (!el.dataset.gridAnimId) {
    el.dataset.gridAnimId = String(nextId++);
  }
  return el.dataset.gridAnimId;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Returns el's bounding rect relative to containerRect.
 * Top/left are floored at 0 so that scrolled-above elements don't go negative.
 */
function relativeBounds(containerRect, el) {
  const r = el.getBoundingClientRect();
  return {
    top    : Math.max(r.top    - containerRect.top,  0),
    left   : Math.max(r.left   - containerRect.left, 0),
    width  : r.width,
    height : r.height,
  };
}

// ---------------------------------------------------------------------------
// Transform application
// ---------------------------------------------------------------------------

/**
 * Applies translateX/Y + scaleX/Y to `el`.
 * Also compensates the first child so its *content* doesn't stretch.
 *
 * @param {HTMLElement} el
 * @param {{ translateX, translateY, scaleX, scaleY }} transform
 * @param {{ immediate?: boolean }} opts
 */
function applyTransform(el, { translateX, translateY, scaleX, scaleY }, { immediate = false } = {}) {
  const isIdentity = translateX === 0 && translateY === 0 && scaleX === 1 && scaleY === 1;

  const setParent = () => {
    el.style.transform = isIdentity
      ? ''
      : `translateX(${translateX}px) translateY(${translateY}px) scaleX(${scaleX}) scaleY(${scaleY})`;
  };

  if (immediate) {
    setParent();
  } else {
    requestAnimationFrame(setParent);
  }

  // Counter-scale the inner wrapper so content stays undistorted
  const inner = el.children[0];
  if (inner) {
    const setChild = () => {
      inner.style.transform = isIdentity
        ? ''
        : `scaleX(${1 / scaleX}) scaleY(${1 / scaleY})`;
    };
    if (immediate) {
      setChild();
    } else {
      requestAnimationFrame(setChild);
    }
  }
}

// ---------------------------------------------------------------------------
// Tween (requestAnimationFrame-based)
// ---------------------------------------------------------------------------

/**
 * Animates numeric values from `from` to `to` over `duration` ms.
 *
 * @param {object}   from      - { translateX, translateY, scaleX, scaleY }
 * @param {object}   to        - same shape
 * @param {number}   duration  - ms
 * @param {function} ease      - easing function  t→t
 * @param {function} onUpdate  - called each frame with current values
 * @param {function} onComplete
 * @returns {{ stop: function }}
 */
function tween({ from, to, duration, ease, onUpdate, onComplete }) {
  let startTime = null;
  let rafId;
  let stopped = false;

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function frame(timestamp) {
    if (stopped) return;
    if (!startTime) startTime = timestamp;

    const elapsed  = timestamp - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = ease(progress);

    const current = {};
    for (const key of Object.keys(from)) {
      current[key] = lerp(from[key], to[key], eased);
    }

    onUpdate(current);

    if (progress < 1) {
      rafId = requestAnimationFrame(frame);
    } else {
      onComplete();
    }
  }

  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(rafId);
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Wraps a grid container so that whenever its children move (due to class
 * changes, reordering, adding/removing items, etc.) they animate smoothly
 * using the FLIP technique.
 *
 * @param {HTMLElement} container - The grid/flex container whose children animate.
 * @param {object}      options
 * @param {number}      [options.duration=250]       - Animation duration in ms.
 * @param {number}      [options.stagger=0]          - Extra delay per child index (ms).
 * @param {string}      [options.easing='easeInOut'] - Key from EASINGS map.
 * @param {function}    [options.onStart]            - Called with array of moving elements.
 * @param {function}    [options.onEnd]              - Called with array of moved elements.
 *
 * @returns {{ unwrapGrid: function, forceGridAnimation: function }}
 */
function wrapGrid(container, {
  duration = 250,
  stagger  = 0,
  easing   = 'easeInOut',
  onStart  = () => {},
  onEnd    = () => {},
} = {}) {
  if (!EASINGS[easing]) {
    throw new Error(`"${easing}" is not a valid easing. Valid options: ${Object.keys(EASINGS).join(', ')}`);
  }

  const easeFn = EASINGS[easing];

  // Snapshot store: id → { rect, stopTween? }
  const snapshots = {};

  // Flag to suppress animations we trigger ourselves (e.g. transform resets)
  let selfTriggered = false;
  function withSelfTriggered(fn) {
    selfTriggered = true;
    fn();
    setTimeout(() => { selfTriggered = false; }, 0);
  }

  // ── FIRST: snapshot current positions of all children ──────────────────
  function snapshotChildren() {
    const containerRect = container.getBoundingClientRect();
    for (const child of Array.from(container.children)) {
      if (typeof child.getBoundingClientRect !== 'function') continue;
      const id = ensureId(child);
      if (!snapshots[id]) snapshots[id] = {};
      snapshots[id].rect = relativeBounds(containerRect, child);
    }
  }

  // Take initial snapshot
  snapshotChildren();

  // ── Re-snapshot on resize (debounced) ───────────────────────────────────
  let resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(snapshotChildren, 250);
  }
  window.addEventListener('resize', onResize);

  // ── Re-snapshot on scroll (debounced) ───────────────────────────────────
  let scrollTimer;
  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(snapshotChildren, 20);
  }
  container.addEventListener('scroll', onScroll);

  // ── LAST + INVERT + PLAY: run when the DOM changes ──────────────────────
  function handleMutations(mutations) {
    // Accept either real MutationRecord[] or a sentinel string
    const forced = mutations === 'forceGridAnimation';

    if (!forced) {
      // Only act on class changes or node additions/removals
      const relevant = mutations.filter(m =>
        m.attributeName === 'class' || m.addedNodes.length || m.removedNodes.length
      );
      if (!relevant.length || selfTriggered) return;
    }

    const containerRect = container.getBoundingClientRect();
    const children = Array.from(container.children);

    // Stop any in-flight tweens and reset transforms (FIRST state is already stored)
    children.forEach(child => {
      const snap = snapshots[child.dataset.gridAnimId];
      if (snap && snap.stopTween) {
        snap.stopTween();
        delete snap.stopTween;
        child.style.transform = '';
        const inner = child.children[0];
        if (inner) inner.style.transform = '';
      }
    });

    // LAST: measure new positions, find which children actually moved
    const movers = children
      .map(child => ({
        el       : child,
        newRect  : relativeBounds(containerRect, child),
      }))
      .filter(({ el, newRect }) => {
        const snap = snapshots[el.dataset.gridAnimId];
        if (!snap) {
          // Brand-new child — snapshot it but don't animate
          snapshotChildren();
          return false;
        }
        const { rect } = snap;
        return (
          newRect.top    !== rect.top    ||
          newRect.left   !== rect.left   ||
          newRect.width  !== rect.width  ||
          newRect.height !== rect.height
        );
      });

    // Validate: each grid item must have exactly one wrapper child
    movers.forEach(({ el }) => {
      if (el.children.length > 1) {
        throw new Error(
          'wrapGrid: each grid item must have a single container element wrapping its children.'
        );
      }
    });

    if (!movers.length) return;

    // Notify caller
    withSelfTriggered(() => onStart(movers.map(m => m.el)));

    const completionPromises = [];

    movers.forEach(({ el, newRect }, index) => {
      const snap = snapshots[el.dataset.gridAnimId];

      // INVERT: compute the transform that puts el back at its old position
      const invertedTransform = {
        scaleX     : snap.rect.width  / newRect.width,
        scaleY     : snap.rect.height / newRect.height,
        translateX : snap.rect.left   - newRect.left,
        translateY : snap.rect.top    - newRect.top,
      };

      el.style.transformOrigin = '0 0';
      const inner = el.children[0];
      if (inner && newRect.left === snap.rect.left && newRect.top === snap.rect.top) {
        inner.style.transformOrigin = '0 0';
      }

      // Snap to inverted position immediately (no visible jump)
      applyTransform(el, invertedTransform, { immediate: true });

      const identity = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 };

      let resolvePromise;
      completionPromises.push(new Promise(res => { resolvePromise = res; }));

      // PLAY: animate from inverted → identity
      const startAnimation = () => {
        const { stop } = tween({
          from      : invertedTransform,
          to        : identity,
          duration,
          ease      : easeFn,
          onUpdate  : current => {
            applyTransform(el, current);
            // Keep snapshot fresh during animation
            requestAnimationFrame(() => snapshotChildren());
          },
          onComplete: () => {
            resolvePromise();
            // Update snapshot to final resting position
            snapshotChildren();
          },
        });
        snap.stopTween = stop;
      };

      if (typeof stagger !== 'number' || stagger === 0) {
        requestAnimationFrame(startAnimation);
      } else {
        const timerId = setTimeout(() => requestAnimationFrame(startAnimation), stagger * index);
        snap.stopTween = () => clearTimeout(timerId);
      }
    });

    Promise.all(completionPromises).then(() => {
      onEnd(movers.map(m => m.el));
    });
  }

  // ── MutationObserver ────────────────────────────────────────────────────
  const observer = new MutationObserver(handleMutations);
  observer.observe(container, {
    childList       : true,
    attributes      : true,
    subtree         : true,
    attributeFilter : ['class'],
  });

  // ── Public API ──────────────────────────────────────────────────────────
  return {
    /** Remove all listeners and stop observing. Call this on unmount. */
    unwrapGrid() {
      window.removeEventListener('resize', onResize);
      container.removeEventListener('scroll', onScroll);
      observer.disconnect();
    },

    /** Manually trigger the animation without a real DOM change. */
    forceGridAnimation() {
      handleMutations('forceGridAnimation');
    },
  };
}

export { wrapGrid, EASINGS };
