"use client";

export type ClientUploadResult = {
  url: string;
  mediaType: "image" | "video";
  name: string;
  size: number;
};

type DirectPreparation = {
  direct?: boolean;
  uploadUrl?: string;
  key?: string;
  reservation?: string;
  error?: string;
};

async function jsonResult<T>(response: Response) {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "파일을 첨부하지 못했습니다.");
  return payload;
}
export async function uploadMediaFile(file: File, {
  signal,
  admin = false,
}: {
  signal?: AbortSignal;
  admin?: boolean;
} = {}): Promise<ClientUploadResult> {
  const contextHeaders: Record<string, string> = admin ? { "X-Upload-Context": "admin" } : {};
  const prepared = await fetch("/api/uploads", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...contextHeaders },
    body: JSON.stringify({
      action: "prepare",
      name: file.name,
      contentType: file.type,
      size: file.size,
    }),
  }).then((response) => jsonResult<DirectPreparation>(response));

  if (prepared.direct && prepared.uploadUrl && prepared.key && prepared.reservation) {
    try {
      const uploaded = await fetch(prepared.uploadUrl, {
        method: "PUT",
        signal,
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploaded.ok) throw new Error("파일 저장소 업로드에 실패했습니다.");
      return fetch("/api/uploads", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", ...contextHeaders },
        body: JSON.stringify({
          action: "complete",
          name: file.name,
          key: prepared.key,
          reservation: prepared.reservation,
        }),
      }).then((response) => jsonResult<ClientUploadResult>(response));
    } catch (error) {
      await fetch("/api/uploads", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...contextHeaders },
        body: JSON.stringify({
          action: "cancel",
          key: prepared.key,
          reservation: prepared.reservation,
        }),
      }).catch(() => undefined);
      throw error;
    }
  }

  const form = new FormData();
  form.append("file", file, file.name);
  return fetch("/api/uploads", {
    method: "POST",
    body: form,
    signal,
    headers: contextHeaders,
  }).then((response) => jsonResult<ClientUploadResult>(response));
}
