/**
 * The slice of the Swell API the shared code uses. `req.swell` inside
 * functions satisfies it, and so does the frontend worker's own client.
 */
export interface SwellClient {
  get(url: string, query?: any): Promise<any>;
  post(url: string, data: any): Promise<any>;
  put(url: string, data: any): Promise<any>;
  delete(url: string): Promise<any>;
  settings(id?: string): Promise<Record<string, any>>;
}

/** Who is acting: the platform client, this app's slug and the store. */
export interface AppContext {
  swell: SwellClient;
  appId: string;
  storeId: string;
  /** This install's public key (`app_pk_…`); it changes when the app is installed again */
  publicKey?: string | null;
}

/** A failure the merchant should see, with a stable code for the UI. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
