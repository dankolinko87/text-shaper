import {
  Brush,
  Download,
  Frame,
  GalleryHorizontal,
  GripVertical,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns2,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  FolderOpen,
  Hand,
  LayoutDashboard,
  Waypoints,
  X,
  Lock,
  LockOpen,
  Maximize,
  Minus,
  MousePointer2,
  Pause,
  Pencil,
  PenTool,
  Pipette,
  Play,
  Plus,
  Redo2,
  Repeat,
  RotateCcw,
  Rows2,
  Save,
  Square,
  Blend,
  Crop,
  Image as ImageIcon,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react'

export type IconName =
  | 'cursor'
  | 'brush'
  | 'pencil'
  | 'pen'
  | 'mosaic'
  | 'mesh'
  | 'hand'
  | 'duplicate'
  | 'trash'
  | 'undo'
  | 'redo'
  | 'eye'
  | 'eyeOff'
  | 'lock'
  | 'unlock'
  | 'plus'
  | 'minus'
  | 'fit'
  | 'play'
  | 'pause'
  | 'stop'
  | 'chevronUp'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'loop'
  | 'restart'
  | 'warning'
  | 'save'
  | 'folder'
  | 'download'
  | 'frame'
  | 'grip'
  | 'splitVertical'
  | 'spread'
  | 'more'
  | 'pipette'
  | 'collapse'
  | 'close'
  | 'splitHorizontal'
  | 'image'
  | 'crop'
  | 'square'
  | 'blend'

/**
 * The three sizes an icon may be, and there are only three on purpose.
 *
 * The set had drifted to 11, 13, 14, 16 and 20 — five sizes for four jobs, each
 * one picked to suit whatever control was being written that day. A free number
 * invites a sixth. A union means the compiler asks the question instead.
 *
 * - 20 — standard controls, in a 32px button. The toolbar, the top bar, zoom.
 * - 16 — dense rows and labelled buttons, where 20 would crowd the text.
 * - 13 — inline marks: a warning beside 12px type, and the small pills that
 *   float on the canvas in 16px buttons.
 */
export type IconSize = 13 | 16 | 20

interface IconProps {
  name: IconName
  size?: IconSize
}

const DEFAULT_SIZE: IconSize = 20

/**
 * The app's icons, drawn by Lucide.
 *
 * Hand-drawn before, on a 16px grid at 1.5 stroke. Thirty-one glyphs is enough
 * for inconsistency to show — a curve here that is a hair heavier than the one
 * beside it — and every new control meant drawing another. Lucide is the same
 * minimal outline language on a 24px grid, so this reads as the set being
 * tightened rather than replaced.
 *
 * The NAMES stay ours. Every call site says `cursor` or `mosaic`, which is what
 * the icon means in this app, not what a library happens to call it this year —
 * Lucide has renamed icons between versions before. Swapping libraries again, or
 * changing which glyph stands for a tool, is a line in this table and nothing
 * else in the app moves.
 */
const ICONS: Record<IconName, LucideIcon> = {
  cursor: MousePointer2,
  brush: Brush,
  // The freehand tool that draws an open line, as opposed to `brush`, which
  // closes what it draws into a shape.
  pencil: Pencil,
  pen: PenTool,
  // Unequal panels rather than a regular grid. A mosaic's tiles are dissected to
  // whatever sizes the composition wants, and an even 3×3 would promise a
  // regularity the tool spends its whole time letting you break.
  mosaic: LayoutDashboard,
  mesh: Waypoints,
  hand: Hand,
  duplicate: Copy,
  trash: Trash2,
  undo: Undo2,
  redo: Redo2,
  eye: Eye,
  eyeOff: EyeOff,
  lock: Lock,
  unlock: LockOpen,
  plus: Plus,
  minus: Minus,
  fit: Maximize,
  play: Play,
  pause: Pause,
  stop: Square,
  chevronUp: ChevronUp,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  loop: Repeat,
  restart: RotateCcw,
  warning: TriangleAlert,
  save: Save,
  folder: FolderOpen,
  // The tile is the box and the new edge is the divider: splitting on the x axis
  // puts a line down it and leaves two columns, which is what `Columns2` draws.
  splitVertical: Columns2,
  /*
   * A frame's states laid out side by side. `GalleryHorizontal` is literally a
   * row of panels, which is what the view is — and it is deliberately NOT
   * `splitVertical`: that already means cutting a mosaic tile in two, and one
   * glyph meaning two things is a bug waiting for a careless glance.
   */
  spread: GalleryHorizontal,
  // Three dots: a few more actions, kept behind one glyph until wanted.
  more: Ellipsis,
  // The eyedropper: pick a colour from anything on the screen.
  pipette: Pipette,
  // The spread's other half: one window again. The same glyph as `stop`, which
  // is fine — a square is a square, and the two never share a bar.
  collapse: Square,
  // Shut a drawer: the plain cross every window has, not the spread's square.
  close: X,
  splitHorizontal: Rows2,
  download: Download,
  frame: Frame,
  grip: GripVertical,
  image: ImageIcon,
  crop: Crop,
  square: Square,
  blend: Blend,
}

/**
 * Filled, unlike the outlined tools.
 *
 * These are transport controls — a state to switch rather than a place to point
 * at — and a hollow triangle reads as an arrow rather than as Play. Carried over
 * from the hand-drawn set, where it was a deliberate choice worth keeping.
 */
const FILLED = new Set<IconName>(['play', 'pause', 'stop'])

/**
 * The stroke, in the icons' own 24px units.
 *
 * Well under the library's default of 2, and deliberately: at the 20px the
 * controls now use this renders a 1.08px hairline, which is finer than anything
 * this app has drawn before. Bigger glyph, lighter line — the icons read as
 * drawn rather than as chrome, and the toolbar stops competing with the
 * artboard for attention.
 *
 * It is the one number that sets the whole set's weight, so it is here rather
 * than at thirty call sites.
 */
const STROKE = 1.3

/**
 * The mark that says a control opens a menu, drawn small enough to sit in the
 * corner of a button without crowding the glyph it belongs to.
 *
 * Its own component rather than an `Icon` at some fourth size, because it is not
 * an icon: it is chrome attached to one, and giving it a size of its own here
 * keeps that size from leaking into the three the icons are allowed. The stroke
 * is scaled to match the set's weight at this size — a mark drawn at the icons'
 * own 1.3 would come out a third as heavy and disappear.
 */
export function FlyoutMarker() {
  return <ChevronDown size={10} strokeWidth={2.6} aria-hidden="true" focusable="false" />
}

export function Icon({ name, size = DEFAULT_SIZE }: IconProps) {
  const Glyph = ICONS[name]
  const filled = FILLED.has(name)
  return (
    <Glyph
      size={size}
      strokeWidth={STROKE}
      // A filled glyph needs no outline of its own: stroking it as well thickens
      // the shape by half a pixel on every side and rounds off its corners.
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      aria-hidden="true"
      focusable="false"
    />
  )
}
