/**
 * Edge and corner resizing for the floating panels.
 *
 * WHY THIS EXISTS INSTEAD OF `resize: both`
 *
 * The panels used the CSS `resize` property, which gives you a grip in the bottom-right
 * corner and nothing else. Two problems, and the second is the one that made it feel broken:
 *
 *   1. One corner is not how windows work. You expect to grab any edge.
 *   2. It did not track the cursor. `resize` drags in the element's OWN untransformed
 *      coordinate space, and the centred dialogs carry `transform: translate(-50%, -50%)`.
 *      Growing the width by N therefore moved the left edge by -N/2 and the right edge by
 *      +N/2, so the corner ran away from the pointer at double speed. The further you
 *      dragged the further behind it got.
 *
 * So: real dragging, in VIEWPORT coordinates, writing explicit width/height. The grabbed
 * edge stays under the cursor because that is the thing being solved for.
 *
 * HOW IT ATTACHES
 *
 * One delegated listener on the document rather than handles injected per panel. That
 * matters here because these panels come from both halves of the app - the log and the
 * candidates window are rendered by main.js, the downloads and metadata windows by Preact -
 * and a delegated listener needs no mount hook, no cleanup, and no cross-boundary call. A
 * panel added to PANELS works whichever half draws it, and whenever it appears.
 */

//? The panels that can be resized, by id. Anything absolutely/fixed positioned with a size
//? of its own is a candidate; inline content is not.
const PANELS = ['log-window', 'downloads-window', 'candidates-window', 'metadata-window'];

//? How close to an edge counts as grabbing it. 6px is about the smallest that doesn't feel
//? fiddly with a mouse; the panels all have padding, so this zone sits in dead space rather
//? than over their content.
const EDGE = 6;

const CURSORS = {
    'n': 'ns-resize', 's': 'ns-resize',
    'e': 'ew-resize', 'w': 'ew-resize',
    'nw': 'nwse-resize', 'se': 'nwse-resize',
    'ne': 'nesw-resize', 'sw': 'nesw-resize',
};

/** The panel under this event, or null. */
function panelFor(target) {
    if (!(target instanceof Element)) return null;

    for (const id of PANELS) {
        const panel = target.closest(`#${id}`);
        if (panel) return panel;
    }

    return null;
}

/**
 * Which edge the pointer is on, as a compass string, or '' for none.
 *
 * Measured against getBoundingClientRect, which is the TRANSFORMED box - the one actually on
 * screen and the one the user is pointing at. That is the whole reason this works where the
 * native property didn't.
 */
function edgeAt(panel, clientX, clientY) {
    const box = panel.getBoundingClientRect();

    /*
      A visible scrollbar lives inside the right edge, so treat that strip as content rather
      than as a resize handle - otherwise you can never drag the scrollbar of a panel that
      has one. Same reasoning vertically.
     */
    const scrollbarX = panel.offsetWidth - panel.clientWidth;
    const scrollbarY = panel.offsetHeight - panel.clientHeight;

    const nearW = clientX - box.left <= EDGE;
    const nearE = box.right - clientX <= EDGE + scrollbarX && box.right - clientX >= scrollbarX;
    const nearN = clientY - box.top <= EDGE;
    const nearS = box.bottom - clientY <= EDGE + scrollbarY && box.bottom - clientY >= scrollbarY;

    return `${nearN ? 'n' : nearS ? 's' : ''}${nearW ? 'w' : nearE ? 'e' : ''}`;
}

/**
 * Convert a transform-centred panel into explicit left/top, once.
 *
 * The centred dialogs are positioned with `left: 50%; top: 50%` plus
 * `transform: translate(-50%, -50%)`. You cannot resize that from an edge sensibly: changing
 * the width moves BOTH edges, so grabbing the right edge drags the left one along with it.
 *
 * Freezing pins the panel where it currently appears and drops the transform, after which
 * width and height mean what they say and the opposite edge stays put. Done at drag start
 * rather than up front so the entrance animation - which is a transform - still plays.
 */
function originOf(panel) {
    /*
      Where this panel's `left`/`top` are measured FROM.

      getBoundingClientRect is in viewport coordinates, but `style.left` on an absolutely
      positioned element is relative to its offsetParent - and the log and downloads panels
      are absolute inside their dropdown wrapper, not fixed. Writing a viewport x into
      `style.left` therefore threw them most of a screen sideways on the first drag.

      Fixed-position panels have no offsetParent, and their coordinates already ARE viewport
      coordinates, so the zero origin is the right answer for them.
    */
    const parent = panel.offsetParent;
    if (!parent) return { left: 0, top: 0 };

    const parentBox = parent.getBoundingClientRect();
    return { left: parentBox.left, top: parentBox.top };
}

function freeze(panel) {
    if (panel.dataset['resizeFrozen']) return;

    const box = panel.getBoundingClientRect();
    const origin = originOf(panel);

    //? These panels are anchored with `right: 0`. Setting `left` as well would pin both edges
    //? and stretch the box instead of moving it, so the anchor has to be released first.
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';

    panel.style.left = `${box.left - origin.left}px`;
    panel.style.top = `${box.top - origin.top}px`;

    /*
      SIZE comes from offsetWidth/offsetHeight, not from the rect.

      getBoundingClientRect() reports the TRANSFORMED box, and these panels open with a
      `scale(0.98)` entrance animation. Grabbing an edge while that was still running froze
      the scaled measurement as the panel's real size, so it jumped by the difference the
      moment you started dragging. offsetWidth is the layout box and ignores transforms
      entirely, which is what makes this correct at any point in the animation.

      Position still comes from the rect, because there the transformed value is exactly what
      is wanted: where the panel actually is on screen.
    */
    panel.style.width = `${panel.offsetWidth}px`;
    panel.style.height = `${panel.offsetHeight}px`;
    panel.style.transform = 'none';
    //? max-height/max-width in the sheet are viewport-relative and would fight a drag that
    //? tries to exceed them; the min clamp below enforces the real limit instead.
    panel.style.maxWidth = 'none';
    panel.style.maxHeight = 'none';
    panel.dataset['resizeFrozen'] = '1';
}

/**
 * Undo freeze() so the panel re-centres and re-animates next time it opens.
 *
 * Without this a dialog you resized once would stay pinned at that exact viewport position
 * forever, including after the window is resized to something smaller - where it might be
 * entirely off screen with no way to get it back.
 */
function thaw(panel) {
    if (!panel.dataset['resizeFrozen']) return;

    //? Position only. Width and height are the remembered size and stay put - see the note
    //? on SIZE_STORAGE_KEY for why one is kept and the other deliberately isn't.
    for (const property of ['left', 'top', 'right', 'bottom', 'transform']) {
        panel.style[property] = '';
    }

    delete panel.dataset['resizeFrozen'];
}

/*
  Remembered sizes.

  A panel you resized should still be that size next time you open it - resizing the log
  every session because it defaults to something too small is exactly the sort of small
  friction that makes an interface tiring.

  SIZE is remembered; POSITION is not. That asymmetry is deliberate: a dialog pinned to
  absolute viewport coordinates can end up entirely off screen after the browser window is
  made smaller, with no way left to grab it. Size has no such failure mode, because it is
  re-clamped against the viewport every time it is applied.
*/
const SIZE_STORAGE_KEY = 'jimbrainz-panel-sizes';

function readSizes() {
    try {
        const saved = JSON.parse(localStorage.getItem(SIZE_STORAGE_KEY));
        return saved && typeof saved === 'object' ? saved : {};
    }

    catch {
        return {};
    }
}

function saveSize(id, width, height) {
    try {
        const sizes = readSizes();
        sizes[id] = { width: Math.round(width), height: Math.round(height) };
        localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(sizes));
    }

    catch {
        // storage unavailable - the panel still resized, it just won't be remembered
    }
}

/**
 * Put a remembered size back on a panel.
 *
 * Clamped to the viewport on every application rather than trusting what was stored: the
 * window it was sized in may have been much larger than the one it is being restored into,
 * and a panel wider than the screen is worse than one that forgot its size.
 */
function applySavedSize(panel) {
    const saved = readSizes()[panel.id];
    if (!saved) return;

    const width = Math.min(saved.width, window.innerWidth - 16);
    const height = Math.min(saved.height, window.innerHeight - 16);

    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.maxWidth = 'none';
    panel.style.maxHeight = 'none';
}

let drag = null;

function onPointerDown(event) {
    //? Left button only, and never on touch - a 6px edge zone is unusable with a finger, and
    //? these panels are full-width on mobile anyway (see the responsive block).
    if (event.button !== 0 || event.pointerType === 'touch') return;

    const panel = panelFor(event.target);
    if (!panel) return;

    const edge = edgeAt(panel, event.clientX, event.clientY);
    if (!edge) return;

    //? Only now, so a click anywhere else in the panel is untouched.
    event.preventDefault();
    event.stopPropagation();

    freeze(panel);

    const box = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const origin = originOf(panel);

    drag = {
        panel,
        edge,
        origin,
        startX: event.clientX,
        startY: event.clientY,
        //? Layout box, for the same reason freeze() uses it - see the note there.
        startWidth: panel.offsetWidth,
        startHeight: panel.offsetHeight,
        startLeft: box.left,
        startTop: box.top,
        minWidth: parseFloat(style.minWidth) || 200,
        minHeight: parseFloat(style.minHeight) || 120,
    };

    panel.setPointerCapture?.(event.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = CURSORS[edge];
}

function onPointerMove(event) {
    //? Not dragging: just advertise the affordance. Without a cursor change there is no way
    //? to discover that the edges are grabbable at all.
    if (!drag) {
        const panel = panelFor(event.target);
        if (!panel) return;

        const edge = edgeAt(panel, event.clientX, event.clientY);
        panel.style.cursor = edge ? CURSORS[edge] : '';
        return;
    }

    const { panel, edge, origin, startX, startY, startWidth, startHeight, startLeft, startTop,
            minWidth, minHeight } = drag;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    let width = startWidth;
    let height = startHeight;
    let left = startLeft;
    let top = startTop;

    /*
      Dragging a leading edge (west/north) changes the size AND the position - the trailing
      edge has to stay where it is, which is the behaviour that makes a window feel like a
      window. The min clamp is applied to the size first and the position derived from it, so
      hitting the minimum stops the panel dead instead of letting it slide sideways.
    */
    if (edge.includes('e')) width = Math.max(minWidth, startWidth + dx);
    if (edge.includes('w')) {
        width = Math.max(minWidth, startWidth - dx);
        left = startLeft + (startWidth - width);
    }
    if (edge.includes('s')) height = Math.max(minHeight, startHeight + dy);
    if (edge.includes('n')) {
        height = Math.max(minHeight, startHeight - dy);
        top = startTop + (startHeight - height);
    }

    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    //? Back out of viewport coordinates into the offsetParent's space - see originOf().
    panel.style.left = `${left - origin.left}px`;
    panel.style.top = `${top - origin.top}px`;
}

function onPointerUp() {
    if (!drag) return;

    saveSize(drag.panel.id, drag.panel.offsetWidth, drag.panel.offsetHeight);

    drag.panel.style.cursor = '';
    drag = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
}

document.addEventListener('pointerdown', onPointerDown, true);
document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', onPointerUp);
document.addEventListener('pointercancel', onPointerUp);

/*
  Thaw a panel once it is closed again.

  The panels are shown and hidden by classes on their parents rather than by anything this
  module can hook, so this watches for a frozen panel that has stopped being visible. Cheap:
  it only ever runs for panels that have actually been resized.
*/
const visibility = new MutationObserver(() => {
    for (const id of PANELS) {
        const panel = document.getElementById(id);
        if (!panel) continue;

        const hidden = panel.offsetParent === null;

        if (hidden) {
            if (panel.dataset['resizeFrozen']) thaw(panel);
            //? Cleared so the next open re-applies and re-clamps against whatever the
            //? viewport is by then.
            delete panel.dataset['sizeApplied'];
            continue;
        }

        if (!panel.dataset['sizeApplied']) {
            panel.dataset['sizeApplied'] = '1';
            applySavedSize(panel);
        }
    }
});

visibility.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
});

//? Panels that are already on the page when this runs. The observer above catches the ones
//? Preact mounts later, and anything opened for the first time after load.
for (const id of PANELS) {
    const panel = document.getElementById(id);
    if (panel && panel.offsetParent !== null) {
        panel.dataset['sizeApplied'] = '1';
        applySavedSize(panel);
    }
}
