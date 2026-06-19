// Build-time stub for @fig/autocomplete-generators (and -helpers), aliased in
// when bundling Fig spec modules for the renderer (see generate-command-specs.cjs).
//
// The seed specs import a few prebuilt generator factories. We don't run them:
// file/folder completion is handled by our own `ls`-based path completion, and
// AI / key-value generators are out of scope. Stubbing them to empty generators
// keeps the bundle self-contained (no @fig/* runtime dependency) and makes those
// args yield nothing from the generator path (falling back to path completion).
export const ai = () => ({});
export const filepaths = () => ({});
export const folders = () => ({});
export const keyValue = () => ({});
export const keyValueList = () => ({});
export const valueList = () => ({});
export default {};
