// file: src/handlers/htmlToExe.ts
//
// Packages a zipped HTML/CSS/JS project into a single self-contained
// Windows .exe, entirely client-side.
//
// HOW IT WORKS
// ------------
// A tiny native launcher ("stub") is precompiled offline (see
// stub/src/main.rs) and checked into this handler's asset folder,
// mirroring how batToExe colocates its head/foot .bin files next to
// its handler. At convert time:
//   1. unzip the user's project
//   2. re-zip it deterministically
//   3. concatenate: [stub bytes] + [zip bytes] + [12-byte footer]
//   4. return the resulting bytes as the output file
//
// Windows' PE loader stops reading at the end of the last declared
// section, so data appended after that point is ignored by the OS but
// still present in the file. The stub looks for a magic footer at
// end-of-file, reads the offset it stores, seeks back to that offset in
// its own executable path, unzips from there into a temp dir, then
// points its embedded WebView2 control at index.html.
//
// WHAT YOU STILL HAVE TO PROVIDE
// -------------------------------
// htmlToExe/win-x64.bin must exist — a small native program built once,
// ahead of time, outside this repo's normal build (see stub/ for
// source). Unlike batToExe's fixed 65824-byte content window (baked
// into a reverse-engineered third-party binary), this stub is written
// from scratch, so it uses a self-describing footer instead of a fixed
// window — web projects vary far more in size than a batch script does.
//
// LIMITATIONS
// -----------
// - Windows x64 output only for now.
// - No code signing; unsigned stubs will trigger SmartScreen.
// - No Android APK path here — separate handler, needs real v1/v2 signing.

import JSZip from "jszip";
import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { EOFError, InitializationError } from "src/errors.ts";

import stubUrl from "./htmlToExe/win-x64.bin?url";

const FOOTER_MAGIC = "HXEZ";
const FOOTER_SIZE = 12; // 4 bytes magic + 4 bytes offset (u32 LE) + 4 bytes length (u32 LE)

class htmlToExeHandler implements FormatHandler {
  public name = "htmlToExe";
  public supportedFormats: FileFormat[] = [
    CommonFormats.HTML.builder("html")
      .markLossless()
      .allowFrom(true)
      .allowTo(false),
      CommonFormats.EXE.supported("exe", false, true, true) // Lossless because it stores exact input side
  ]
  public ready = false;

  private stub: Uint8Array | null = null;

  async init() {
    this.stub = await fetch(stubUrl).then(res => res.arrayBuffer()).then(buf => new Uint8Array(buf));
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
  ): Promise<FileData[]> {

    const stub = this.stub;
    if (!this.ready || !stub) throw new InitializationError("Handler not initialized.");

    const outputFiles: FileData[] = [];

    for (const file of inputFiles) {
      if (inputFormat.internal !== "html") {
        throw new TypeError(`Unsupported input format: ${inputFormat.internal}`);
      }
      if (outputFormat.internal !== "exe") {
        throw new TypeError(`Unsupported output format: ${outputFormat.internal}`);
      }

      const path = "./index.html";
      const bytes = new Uint8Array(file.bytes);

      // Zip deterministically. STORE avoids re-encoding assets that
      // are often already compressed (images, fonts); switch to
      // DEFLATE later if output size matters more than build speed.
      const outputArchive = new JSZip();
      
      outputArchive.file(path, bytes, { compression: "STORE" });
      const projectZip = await outputArchive.generateAsync({
        type: "uint8array",
        compression: "STORE",
      });

      // Build the footer. Offset points to where the appended zip
      // begins, i.e. right after the stub.
      const offset = stub.length;
      const footer = new Uint8Array(FOOTER_SIZE);
      const view = new DataView(footer.buffer);
      new TextEncoder().encodeInto(FOOTER_MAGIC, footer.subarray(0, 4));
      view.setUint32(4, offset, true);
      view.setUint32(8, projectZip.length, true);

      // Assemble final EXE: stub + zip + footer
      const out = new Uint8Array(stub.length + projectZip.length + footer.length);
      let cursor = 0;
      out.set(stub, cursor);
      cursor += stub.length;
      out.set(projectZip, cursor);
      cursor += projectZip.length;
      out.set(footer, cursor);

      const outputName =
        file.name.split(".").slice(0, -1).join(".") +
        "." +
        outputFormat.extension;

      outputFiles.push({
        name: outputName,
        bytes: out,
      });
    }

    return outputFiles;
  }
}

export default htmlToExeHandler;