-- Add M360 auth + webhook-registration fields to CmproConfig.
-- refreshToken: required for the refresh_token grant used by getToken().
-- webhookId / installId: returned by the CMP Plugins registration call.
ALTER TABLE "CmproConfig" ADD COLUMN "refreshToken" TEXT;
ALTER TABLE "CmproConfig" ADD COLUMN "webhookId" TEXT;
ALTER TABLE "CmproConfig" ADD COLUMN "installId" TEXT;
