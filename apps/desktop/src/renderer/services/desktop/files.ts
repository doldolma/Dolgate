import type { DesktopApi } from "@shared";
import { desktopApi } from "../desktopApi";

type FilesApi = DesktopApi["files"];

export function listLocalRoots() {
  return desktopApi.files.listRoots();
}

export function getLocalParentPath(
  targetPath: Parameters<FilesApi["getParentPath"]>[0],
) {
  return desktopApi.files.getParentPath(targetPath);
}
