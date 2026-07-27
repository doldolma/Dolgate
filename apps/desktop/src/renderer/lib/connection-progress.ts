import type { ConnectionProgressStage } from "@shared";
import { t } from '../i18n';

export function formatConnectionProgressStageLabel(
  stage?: ConnectionProgressStage,
): string {
  switch (stage) {
    case "loading-instance-metadata":
      return t('connectStage.sshConfig');
    case "checking-profile":
      return t('connectStage.awsProfile');
    case "browser-login":
      return t('connectStage.browserLogin');
    case "checking-ssm":
      return t('connectStage.ssmStatus');
    case "probing-host-key":
      return t('connectStage.hostKey');
    case "generating-key":
      return t('connectStage.tempKey');
    case "sending-public-key":
      return t('connectStage.pushKey');
    case "opening-tunnel":
      return t('connectStage.internalTunnel');
    case "connecting-sftp":
      return t('connectStage.sftp');
    case "connecting-containers":
      return t('connectStage.containers');
    case "loading-ecs-cluster":
      return t('connectStage.ecsClusters');
    case "loading-ecs-metrics":
      return t('connectStage.usageMetrics');
    default:
      return t('connectStage.preparing');
  }
}
