import axios from 'axios';
import { toast } from 'react-hot-toast';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// API client
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for JWT
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('jwt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor for errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('jwt_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// API services
export const accountApi = {
  list: () => api.get('/api/accounts'),
  create: (data) => api.post('/api/accounts', data),
  delete: (id: string) => api.delete(`/api/accounts/${id}`),
  stats: (id: string) => api.get(`/api/accounts/${id}/stats`),
};

export const campaignApi = {
  list: () => api.get('/api/campaigns'),
  create: (data) => api.post('/api/campaigns', data),
  update: (id: string, data: any) => api.patch(`/api/campaigns/${id}`, data),
  getStats: (id: string) => api.get(`/api/campaigns/${id}/stats`),
};

export const loreApi = {
  list: () => api.get('/api/lore'),
  create: (data) => api.post('/api/lore', data),
  addExample: (loreId: string, data: { tweet_text: string; reply_text: string }) => 
    api.post(`/api/lore/${loreId}/examples`, data),
};

export const proxyApi = {
  add: (accountId: string, data: { proxy_string: string; geo_location: string }) => 
    api.post(`/api/accounts/${accountId}/proxy`, data),
  getStatus: (accountId: string) => api.get(`/api/accounts/${accountId}/proxy/status`),
};

export const statsApi = {
  getOverview: () => api.get('/api/stats/overview'),
};

export const alertsApi = {
  list: () => api.get('/api/alerts'),
  markAsRead: (id: string) => api.patch(`/api/alerts/${id}/read`),
};

// Auth
export const authApi = {
  login: (username: string, password: string) => 
    api.post('/api/auth/login', { username, password }),
  register: (data: any) => api.post('/api/auth/register', data),
};

export default api;
