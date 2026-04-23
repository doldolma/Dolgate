import mobilePackage from "../../package.json";

const packageVersion =
  typeof mobilePackage.version === "string" && mobilePackage.version.trim()
    ? mobilePackage.version.trim()
    : "0.0.0";

export const APP_VERSION = packageVersion;
