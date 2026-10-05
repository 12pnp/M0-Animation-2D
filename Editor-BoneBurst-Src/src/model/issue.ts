/** Something about a file the editor reports: where in it (a readable path), and what. */
export interface Issue {
  readonly where: string;
  readonly message: string;
}
