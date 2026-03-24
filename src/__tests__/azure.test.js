import { describe, it, expect } from "vitest";
import { envNameSuggestsAzure, azureDepsFromEnv, azureDepsFromItem } from "../utils/azure.js";

describe("envNameSuggestsAzure", () => {
  it("detects azure in name", () => expect(envNameSuggestsAzure("AZURE_STORAGE_KEY")).toBe(true));
  it("detects servicebus", () => expect(envNameSuggestsAzure("SERVICEBUS_CONN")).toBe(true));
  it("detects keyvault", () => expect(envNameSuggestsAzure("KEYVAULT_URL")).toBe(true));
  it("detects cosmos", () => expect(envNameSuggestsAzure("COSMOS_DB_ENDPOINT")).toBe(true));
  it("rejects plain name", () => expect(envNameSuggestsAzure("DATABASE_URL")).toBe(false));
  it("rejects empty", () => expect(envNameSuggestsAzure("")).toBe(false));
});

describe("azureDepsFromEnv", () => {
  it("detects ACR from env value", () => {
    const deps = azureDepsFromEnv([{ name: "REGISTRY", value: "myacr.azurecr.io/app:v1" }]);
    expect(deps.some(d => d.serviceType === "ACR")).toBe(true);
  });

  it("detects Key Vault from env value", () => {
    const deps = azureDepsFromEnv([{ name: "KV", value: "https://myvault.vault.azure.net" }]);
    expect(deps.some(d => d.serviceType === "Key Vault")).toBe(true);
  });

  it("detects Service Bus", () => {
    const deps = azureDepsFromEnv([{ name: "SB", value: "myhub.servicebus.windows.net" }]);
    expect(deps.some(d => d.serviceType === "Service Bus")).toBe(true);
  });

  it("detects Cosmos DB", () => {
    const deps = azureDepsFromEnv([{ name: "DB", value: "mydb.documents.azure.com" }]);
    expect(deps.some(d => d.serviceType === "Cosmos DB")).toBe(true);
  });

  it("returns empty for non-azure env", () => {
    const deps = azureDepsFromEnv([{ name: "PORT", value: "8080" }]);
    expect(deps).toHaveLength(0);
  });
});

describe("azureDepsFromItem", () => {
  it("detects workload identity from pod labels", () => {
    const item = {
      kind: "Pod",
      metadata: { labels: { "azure.workload.identity/use": "true" }, annotations: { "azure.workload.identity/client-id": "abc-123" } },
      spec: { containers: [] },
    };
    const deps = azureDepsFromItem(item);
    expect(deps.some(d => d.serviceType === "Managed Identity")).toBe(true);
  });

  it("detects Azure Files PVC", () => {
    const item = {
      kind: "PersistentVolumeClaim",
      metadata: { labels: {}, annotations: {} },
      spec: { storageClassName: "azurefile-csi" },
    };
    const deps = azureDepsFromItem(item);
    expect(deps.some(d => d.serviceType === "Azure Files")).toBe(true);
  });

  it("detects ACR from container image", () => {
    const item = {
      kind: "Pod",
      metadata: { labels: {}, annotations: {} },
      spec: { containers: [{ name: "app", image: "myacr.azurecr.io/app:latest", env: [] }] },
    };
    const deps = azureDepsFromItem(item);
    expect(deps.some(d => d.serviceType === "ACR")).toBe(true);
  });
});
