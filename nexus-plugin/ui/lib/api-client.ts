export interface ApiError {
  status: number;
  message: string;
  code?: string;
}

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
  };
}

class TriggerApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = this.resolveBaseUrl();
  }

  private resolveBaseUrl(): string {
    if (process.env.NEXT_PUBLIC_API_URL) {
      return process.env.NEXT_PUBLIC_API_URL;
    }
    if (typeof window !== 'undefined') {
      return window.location.origin;
    }
    return '';
  }

  private getAuthToken(): string | null {
    if (typeof window === 'undefined') return null;

    // Read JWT from the main Nexus dashboard's localStorage (same origin)
    const dashboardToken = localStorage.getItem('dashboard_token');
    if (dashboardToken) return dashboardToken;

    // Fallback: check Nexus cookie names
    const cookiePattern = /(?:^|;\s*)(?:nexus-auth|nexus_ml_session|auth-token)=([^;]*)/;
    const match = document.cookie.match(cookiePattern);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private buildHeaders(extra?: Record<string, string>): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };

    const token = this.getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<ApiResponse<T>> {
    let url = `${this.baseUrl}/trigger/api/v1${path}`;

    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          searchParams.set(key, String(value));
        }
      });
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const response = await fetch(url, {
      method,
      headers: this.buildHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const error: ApiError = {
        status: response.status,
        message: errorBody.message || response.statusText,
        code: errorBody.code,
      };
      throw error;
    }

    if (response.status === 204) {
      return { data: undefined as T };
    }

    const json = await response.json();
    return json as ApiResponse<T>;
  }

  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, undefined, params);
  }

  async post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', path, body);
  }

  async delete<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path);
  }
}

export const apiClient = new TriggerApiClient();
