// Files imported as text, e.g. `import schema from "./x.proto" with { type: "text" }`.
declare module "*.proto" {
  const content: string;
  export default content;
}
