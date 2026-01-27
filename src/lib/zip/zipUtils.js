import JSZip from "jszip";

export async function zipTextFiles(fileMap /* array of {name, text} */) {
  const zip = new JSZip();
  for (const f of fileMap) {
    // Sanitize filename to prevent path traversal
    const baseName = f.name.split(/[\\/]/).pop(); // Remove any path components
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
    zip.file(safeName, f.text);
  }
  return zip.generateAsync({ type: "blob" });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
