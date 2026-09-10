/**
 * The Text Shaper mark.
 *
 * Its own component rather than a file loaded through an `<img>`: inline SVG
 * takes `currentColor`, so the mark is the same colour as the text around it and
 * follows the app's palette instead of being a black rectangle pinned to a dark
 * header. It also costs no request and cannot arrive late, which for the first
 * thing on screen matters more than it sounds.
 *
 * The artwork is 67 × 90 — TALLER than it is wide, so it is sized by height and
 * lets its width follow. A mark sized by width would grow past the header the
 * moment anyone nudged the number.
 */

/** Natural proportions of the artwork, so a height is all a caller gives. */
const ASPECT = 67 / 90

interface LogoProps {
  /** Height in pixels. The width follows from the artwork's own proportions. */
  size?: number
}

export function Logo({ size = 22 }: LogoProps) {
  return (
    <svg
      width={size * ASPECT}
      height={size}
      viewBox="0 0 67 90"
      fill="none"
      role="img"
      aria-label="Text Shaper"
      focusable="false"
    >
      <path
        d="M55.8055 26.1031C56.9563 26.1031 57.5317 26.6765 57.5317 27.8233V35.5645C57.5317 36.7114 58.1071 37.2848 59.2579 37.2848L67 37.2352V44.1162L53.9147 44.0791C51.931 44.0791 51.922 45.7103 53.0145 46.0732C54.1069 46.4361 57.5317 46.4289 57.5317 49.6544C57.5317 52.8799 57.5317 75.121 57.5317 75.121C57.5317 80.4947 60.9173 83.1216 66.9997 83.1216V90C48.7955 90 36.4108 80.4133 36.4108 63.5612V31.1772C36.4108 26.0164 42.5431 26.0164 43.6939 26.0164L55.8055 26.1031ZM30.0887 0C39.2187 0 57.5317 3.6642 57.5317 18.3294V20.8556C57.5317 22.0025 56.9563 22.5759 55.8055 22.5759H38.2316C37.0808 22.5759 36.4108 22.0025 36.4108 20.8556V14.4992C36.4108 10.9365 33.6636 8.00786 30.0887 8.00786C26.5137 8.00786 23.6922 10.8962 23.6922 14.4588V35.6441C23.6923 36.7907 24.2708 37.3643 25.4276 37.3644H31.9961C32.0828 37.3644 32.1662 37.3688 32.2464 37.3753V44.0119C32.1662 44.0184 32.0828 44.0237 31.9961 44.0237H25.4251C24.2746 44.0238 23.699 44.5975 23.6989 45.7439L23.6912 88.1855C23.6912 89.3319 23.116 89.9051 21.9657 89.9051H5.37861C4.22826 89.9051 3.65308 89.3319 3.65308 88.1855V45.7439C3.65295 44.5974 3.0775 44.0237 1.92689 44.0237H0.863094C0.287698 44.0237 0 43.737 0 43.1636V38.2245C0 37.6511 0.287698 37.3644 0.863094 37.3644H8.83164C9.98228 37.3644 10.9201 37.0161 10.5578 35.6441C10.1956 34.2722 0.201371 30.6558 2.78999 18.4126C5.37861 6.16936 18.4633 0 30.0887 0Z"
        fill="currentColor"
      />
    </svg>
  )
}
