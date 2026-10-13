// doiuse ships types that its package.json "exports" hides from this tsconfig.
declare module "doiuse" {
  import type { Plugin } from "postcss";

  export default function doiuse(options: {
    browsers: string[];
    ignore?: string[];
    onFeatureUsage?: (info: { message: string }) => void;
  }): Plugin;
}
