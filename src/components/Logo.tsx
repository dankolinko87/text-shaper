/**
 * The Text Shaper mark: the "ft" ligature, on nothing.
 *
 * Its own component rather than a file loaded through an `<img>`: inline SVG
 * takes `currentColor`, so the mark is the same colour as the text around it
 * and follows the app's palette instead of being a black shape pinned to a
 * dark header. It also costs no request and cannot arrive late, which for
 * the first thing on screen matters more than it sounds.
 *
 * The artwork is 80 × 111 — TALLER than it is wide, so it is sized by height
 * and lets its width follow. A mark sized by width would grow past the header
 * the moment anyone nudged the number.
 */

/** Natural proportions of the artwork, so a height is all a caller gives. */
const ASPECT = 80 / 111

interface LogoProps {
  /** Height in pixels. The width follows from the artwork's own proportions. */
  size?: number
}

export function Logo({ size = 22 }: LogoProps) {
  return (
    <svg
      width={size * ASPECT}
      height={size}
      viewBox="0 0 80 111"
      fill="none"
      role="img"
      aria-label="Text Shaper"
      focusable="false"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M68.6119 34.84C68.6119 33.4723 67.9257 32.7884 66.5533 32.7884L49.4517 32.685C45.4517 32.685 43.4233 33.4833 43.4233 38.9833V77.4607C43.4233 85.4614 43.0185 95.2681 45.9517 100.863C51.6104 111.657 64.4578 113.491 79.9034 103.515V93.3123C74.4517 95.662 68.6119 95.6555 68.6119 89.2468V62.8756C68.6119 59.7041 65.8354 59.1532 64.1306 58.8149C63.7677 58.7429 63.4533 58.6806 63.2247 58.6046C61.9218 58.1718 61.9326 56.2265 64.2983 56.2265L77.9517 56.2708L79.9037 46.0645L70.6705 46.1236C69.2981 46.1236 68.6119 45.4398 68.6119 44.0721V34.84Z"
        fill="currentColor"
      />
      <path
        d="M62.4517 29.0819C62.4517 29.0819 67.9517 29.5342 68.6119 24.0176C69.2721 18.501 65.8045 10.6585 58.4517 6.17849C51.0988 1.69848 44.1112 -0.415506 34.4517 0.0675822C25.8338 0.498574 19.2101 2.46448 13.4517 6.93716C7.46323 11.5885 4.10532 16.9256 2.95166 24.9256C1.798 32.9256 5.9295 39.3398 10.9512 43.1408C11.8596 43.8285 12.4972 44.3111 12.5912 44.667C13.0232 46.3033 11.9048 46.7186 10.5326 46.7186H1.02932C0.343106 46.7186 0 47.0605 0 47.7444V55.6346C0 56.3185 0.343106 56.6604 1.02932 56.6604H2.298C3.67021 56.6604 4.35649 57.3446 4.35664 58.712V107.327C4.35664 108.695 5.04259 109.378 6.41449 109.378H18.9517C30.3218 109.378 28.2539 95.4014 28.2539 94.0342L28.2632 58.712C28.2633 57.3447 28.9497 56.6605 30.3218 56.6604C33.008 56.6604 36.4517 56.6464 36.4517 56.6464L38.4568 46.7316C38.4568 46.7316 33.0098 46.7186 30.3248 46.7186C28.9452 46.7185 28.2552 46.0344 28.2551 44.667V21.9833C28.2551 13.9833 31.4517 11.0342 35.9517 10.5342C41.418 9.92681 44.4517 14.0342 44.4517 14.0342L43.4233 23.4833C42.9517 27.5342 45.4517 29.0819 49.4517 29.0819H62.4517Z"
        fill="currentColor"
      />
    </svg>
  )
}
