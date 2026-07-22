export type HostExportFileExtension = "dolgate" | "ssh-config";

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function createHostExportFileName(
  extension: HostExportFileExtension,
  createdAt = new Date(),
): string {
  const date = [
    createdAt.getFullYear(),
    twoDigits(createdAt.getMonth() + 1),
    twoDigits(createdAt.getDate()),
  ].join("");
  const time = [
    twoDigits(createdAt.getHours()),
    twoDigits(createdAt.getMinutes()),
    twoDigits(createdAt.getSeconds()),
  ].join("");
  return `hosts-${date}-${time}.${extension}`;
}
