/**
 * Minimal Node ambient types for template scaffolds in the monorepo.
 * After copying a template out, run `npm install` (includes @types/node).
 */
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
};

declare function require(id: string): unknown;

declare module "node:*" {
  const exp: unknown;
  export default exp;
}
