/**
 * API client for backend communication
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface CreatePaymentResponse {
  payUrl: string;
  paymentId: string;
  memo: string;
  amount: number;
}

interface SubscriptionStatusResponse {
  active: boolean;
  subscriptionEnd: string | null;
  userExists: boolean;
  telegramId?: string;
  username?: string | null;
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          'Content-Type': 'application/json',
        },
        ...options,
      });

      const data = await response.json();
      
      if (!response.ok) {
        return {
          success: false,
          error: data.error || `HTTP ${response.status}`,
        };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }

  /**
   * Create payment and get Solana Pay URL
   */
  async createPayment(params: {
    telegramId: number;
    username?: string;
    plan?: 'premium';
  }): Promise<ApiResponse<CreatePaymentResponse>> {
    return this.request('/api/subscription/create', {
      method: 'POST',
      body: JSON.stringify({
        telegramId: params.telegramId,
        username: params.username,
        plan: params.plan || 'premium',
      }),
    });
  }

  /**
   * Check subscription status
   */
  async getSubscriptionStatus(telegramId: number): Promise<ApiResponse<SubscriptionStatusResponse>> {
    return this.request(`/api/subscription/status?userId=${telegramId}`);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<ApiResponse<{ status: string; timestamp: string }>> {
    return this.request('/health');
  }
}

export const api = new ApiClient(API_BASE_URL);
export type { CreatePaymentResponse, SubscriptionStatusResponse };
