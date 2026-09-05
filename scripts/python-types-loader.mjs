// @pyodide/ts-to-python 0.1.8 passes a file URL's pathname to fs, which
// produces C:\C:\... on Windows. Pass the URL itself, as Node fs supports.
// This hook runs only during type generation and never changes the package.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (
    process.platform !== "win32" ||
    !url.endsWith("/@pyodide/ts-to-python/dist/adjustments.js")
  ) {
    return result;
  }

  const source = result.source.toString();
  const broken = 'new URL("./prelude.pyi", import.meta.url).pathname';
  const fixed = 'new URL("./prelude.pyi", import.meta.url)';
  if (!source.includes(broken)) {
    throw new Error(
      "The Python type converter changed; review the Windows workaround.",
    );
  }
  return { ...result, source: source.replace(broken, fixed) };
}
