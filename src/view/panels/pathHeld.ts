import { invert, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";

/**
 * The Local Path panel holds the parent still in its frame-0 pose: what is
 * drawn at another frame is carried from where the parent is then (`now`) to
 * where it was at 0 (`at0`), `at0 · now⁻¹`. Identity when either is missing
 * or `now` cannot be inverted.
 */
export function heldParent(at0: Matrix2D | undefined, now: Matrix2D | undefined): Matrix2D {
  const inv = mat();
  return at0 && now && invert(inv, now) ? mul(mat(), at0, inv) : mat();
}
