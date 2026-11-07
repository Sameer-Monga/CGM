import { PDFDocument, type PDFImage } from "pdf-lib";

import { getHeaders } from "@/lib/request";

interface FileCreateResponse {
  id: string;
  signed_url: string;
  internal_name: string;
}

function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to read image"));
    image.src = url;
  });
}

async function rasterizeToJpeg(file: File): Promise<ArrayBuffer> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to read image");
    ctx.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("Failed to convert image")),
        "image/jpeg",
        0.92,
      );
    });
    return blob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function embedImage(pdf: PDFDocument, file: File): Promise<PDFImage> {
  if (file.type === "image/png") {
    return pdf.embedPng(await file.arrayBuffer());
  }
  if (file.type === "image/jpeg" || file.type === "image/jpg") {
    return pdf.embedJpg(await file.arrayBuffer());
  }
  return pdf.embedJpg(await rasterizeToJpeg(file));
}

/**
 * CARE stores one File record per blob, so multiple uploads become multiple
 * cards. Combine pages into a single PDF when more than one file is kept.
 */
export async function combineFilesForReportUpload(
  files: File[],
  displayName: string,
): Promise<File> {
  if (files.length === 1) return files[0];

  const pdf = await PDFDocument.create();
  for (const file of files) {
    if (isPdf(file)) {
      const source = await PDFDocument.load(await file.arrayBuffer());
      const pages = await pdf.copyPages(source, source.getPageIndices());
      pages.forEach((page) => pdf.addPage(page));
      continue;
    }
    const image = await embedImage(pdf, file);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
  }

  const bytes = await pdf.save();
  return new File([bytes], `${displayName}.pdf`, { type: "application/pdf" });
}

interface FileCreateResponse {
  id: string;
  signed_url: string;
  internal_name: string;
}

/**
 * Persist a scanned file to CARE's file storage, attached to a diagnostic report.
 * Mirrors care_fe's useFileUpload flow: create -> PUT to signed URL -> mark upload completed.
 */
export async function uploadDiagnosticReportFile(
  file: File,
  reportId: string,
  displayName: string,
): Promise<void> {
  const createUrl = new URL("/api/v1/files/", window.CARE_API_URL);
  const createRes = await fetch(createUrl.toString(), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      original_name: file.name,
      name: displayName,
      file_type: "diagnostic_report",
      file_category: "unspecified",
      associating_id: reportId,
      mime_type: file.type,
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to register file: ${createRes.status}`);
  }

  const created: FileCreateResponse = await createRes.json();
  // The signed URL expects the object to be named after internal_name, not the original filename.
  const renamedFile = new File([file], created.internal_name, {
    type: file.type,
  });

  const uploadRes = await fetch(created.signed_url, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: renamedFile,
  });

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload file: ${uploadRes.status}`);
  }

  const completeUrl = new URL(
    `/api/v1/files/${created.id}/mark_upload_completed/`,
    window.CARE_API_URL,
  );
  const completeRes = await fetch(completeUrl.toString(), {
    method: "POST",
    headers: getHeaders(),
  });

  if (!completeRes.ok) {
    throw new Error(`Failed to finalize file upload: ${completeRes.status}`);
  }
}
