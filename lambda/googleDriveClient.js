// googleDive.js
const { GoogleAuth } = require("google-auth-library");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { 
    SSMClient, 
    GetParameterCommand, 
    PutParameterCommand 
} = require("@aws-sdk/client-ssm");

const GOOGLE_EXPORTS_TYPES = {
    "application/vnd.google-apps.document":     "application/pdf",
    "application/vnd.google-apps.presentation": "application/pdf",
    "application/vnd.google-apps.spreadsheet":  "text/csv"
};

class GoogleDriveClient {
    constructor(secretId = "demo-google-service-account",
                tokenParameter = "/chatbot/demo-drive/lastSyncToken") {
        this.secretId = secretId;
        this.tokenParameter = tokenParameter;
        this.secrets = new SecretsManagerClient({});
        this.ssm = new SSMClient({});
        this.authClient = null;
    }

    async init() {
        if (this.authClient) return;

        const secret = await this.secrets.send(
            new GetSecretValueCommand({
                SecretId: "demo-google-service-account",
            })
        );
        const credentials = JSON.parse(secret.SecretString);
        
        const auth = new GoogleAuth({
            credentials,
            scopes: [
                "https://www.googleapis.com/auth/drive.readonly",
            ],
        });

        this.authClient = await auth.getClient();
    }

    async request(path, options = {}) {
        await this.init();

        const response = await this.authClient.request({
            url: `https://www.googleapis.com${path}`,
            method: options.method ?? "GET",
            params: options.params,
            data: options.data,
            responseType: options.responseType
        });

        return response.data;
    }

    async getChanges(pageToken) {
        const result = await this.request("/drive/v3/changes", {
                params: {
                    pageToken: pageToken,
                    fields:
                        "nextPageToken,newStartPageToken,\
                        changes(fileId,removed,file(id,name,mimeType,modifiedTime,trashed))"
                }
            }
        );
        result.changes ??= []; // Ensure changes is non-null and iterable
        return result;
    }

    async getMetaData(fileId) {
        return this.request(`/drive/v3/files/${fileId}`, {
            params: {
                fields: "name,mimeType,modifiedTime,webViewLink,parents"
            }
        });
    }

    async getContent(fileId, contentType) {
        const exportType = GOOGLE_EXPORTS_TYPES[contentType];
        if (exportType) {
            const body = await this.exportFile(fileId, exportType);
            return { body, contentType: exportType }
        }
        else {
            const body = await this.downloadFile(fileId);
            return { body, contentType };
        }
    }

    async downloadFile(fileId) {
        const body = Buffer.from(
            await this.request(`/drive/v3/files/${fileId}`, {
                    params: {
                        alt: "media"
                    },
                    responseType: "arraybuffer"
                }
            )
        );
        return body;
    }

    async exportFile(fileId, exportType) {
        const body = Buffer.from(
            await this.request(`/drive/v3/files/${fileId}/export`, {
                    params: {
                        mimeType: exportType
                    },
                    responseType: "arraybuffer"
                }
            )
        );
        return body;
    }

    /**
     * Returns the complete path of the file in the Drive
     * 
     * @param name The name of the file
     * @param parents The parents metadata of the file
     */
    async getFilePath(name, parents) {
        if (!parents?.length) { return name; }
        let parentId = parents[0];

        const data = await this.request(`/drive/v3/files/${parentId}`, {
            params: { fields: "id,name,parents" }
        });
        return await this.getFilePath(`${data.name}/${name}`, data.parents);
    }

    // ==== Token management
    async savePageToken(pageToken) {
        await this.ssm.send(
            new PutParameterCommand({
                Name: this.tokenParameter,
                Value: pageToken,
                Type: "String",
                Overwrite: true
            })
        );
    }

    /**
     * Returns the stored page token. 
     * If no token could be retrieved or if the token is invalid, returns null.
     */
    async loadPageToken() {
        let pageToken;
        // Load token
        try {
            const result = await this.ssm.send(
                new GetParameterCommand({
                    Name: this.tokenParameter
                })
            );

            pageToken = result.Parameter.Value;
        } catch {
            return null;
        }

        // Validate token
        try {
            await this.request("/drive/v3/changes", {
                params: {
                    pageToken,
                    fields: "nextPageToken"
                }
            });
            return pageToken;
        } catch {
            return null;
        }
    }

    async createPageToken() {
        const result = await this.request("/drive/v3/changes/startPageToken");
        await this.savePageToken(result.startPageToken);
        return result.startPageToken;
    }

}

module.exports = GoogleDriveClient;