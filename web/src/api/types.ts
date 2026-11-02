// Типы ответов API. Источник истины — server/openapi.yaml; деньги приходят строками ("1234.5600").

export type Role = 'client' | 'admin';
export type UserStatus = 'active' | 'blocked';
export type InstanceStatus = 'pending' | 'running' | 'stopped' | 'terminated' | 'failed';
export type PricingType = 'on_demand' | 'spot';
export type TxType = 'topup' | 'charge' | 'refund' | 'bonus' | 'adjustment';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type NodeStatus = 'online' | 'maintenance' | 'offline';

export interface User {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  balance: string;
  emailVerified: boolean;
}

/** Ответ регистрации и повторной отправки письма. В демо-режиме вместо письма приходит ссылка. */
export interface VerifyInfo {
  user?: User;
  verifyUrl?: string | null;
}

export interface GpuOffer {
  datacenter: { code: string; name: string; city: string };
  model: { name: string; vramGb: number };
  total: number;
  free: number;
  priceOnDemand: string | null;
  priceSpot: string | null;
}

export interface Template {
  id: number;
  name: string;
  dockerImage: string;
  defaultDiskGb: number;
  defaultPorts: string;
  isPublic: boolean;
}

export interface SshKey {
  id: number;
  name: string;
  fingerprint: string;
  publicKey?: string;
  createdAt: string;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  /** Полный ключ показывается только в этом ответе */
  key: string;
}

export interface Instance {
  id: string;
  name: string;
  status: InstanceStatus;
  datacenter: { code: string; name: string; city?: string };
  gpuModel: string;
  gpuCount: number;
  pricingType: PricingType;
  /** Цена за весь инстанс в час (снимок на момент запуска) */
  pricePerHour: string;
  containerDiskGb: number;
  template: { id: number; name: string } | null;
  volume: { id: number; name: string; sizeGb: number } | null;
  sshKey: { id: number; name: string } | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  terminatedAt: string | null;
  /** Только для админа при ?all=1 */
  owner?: { id: number; email: string };
}

export interface LaunchRequest {
  name: string;
  datacenterCode: string;
  gpuModel: string;
  gpuCount: number;
  pricingType: PricingType;
  templateId: number;
  containerDiskGb: number;
  volumeId?: number;
  sshKeyId?: number;
  env?: Record<string, string>;
}

export interface Volume {
  id: number;
  name: string;
  sizeGb: number;
  datacenter: { code: string; name: string };
  status: 'active' | 'deleted';
  /** Инстанс, к которому подключён том (null — свободен) */
  attachedTo: { id: string; name: string } | null;
  createdAt: string;
}

export interface Balance {
  balance: string;
}

export interface Transaction {
  id: number;
  type: TxType;
  amount: string;
  description: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Payment {
  id: number;
  amount: string;
  status: PaymentStatus;
  createdAt: string;
  paidAt: string | null;
}

export interface PaymentCreated {
  payment: Payment;
  confirmationUrl: string;
}

export interface Spend {
  from: string;
  to: string;
  total: string;
  storage: string;
  byDay: { day: string; amount: string }[];
  byInstance: { instanceId: string; name: string; amount: string }[];
}

// ---- Администратор ----

export interface Dashboard {
  revenueByDay: { day: string; revenue: string; gpuHours: string }[];
  revenueByDatacenter: { code: string; name: string; revenue: string }[];
  revenueByModel: { name: string; revenue: string }[];
  utilization: { total: number; busy: number; free: number; disabled: number };
}

export interface AdminPrice {
  id: number;
  datacenter: { code: string; name: string };
  gpuModel: string;
  pricingType: PricingType;
  pricePerHour: string;
  validFrom: string;
  validTo: string | null;
}

export interface NewPrice {
  datacenterCode: string;
  gpuModel: string;
  pricingType: PricingType;
  pricePerHour: number;
}

export interface InfraGpu {
  id: number;
  slot: number;
  serial: string;
  model: string;
  isEnabled: boolean;
  busy: boolean;
}

export interface InfraNode {
  id: number;
  hostname: string;
  status: NodeStatus;
  cpuCores: number;
  ramGb: number;
  gpus: InfraGpu[];
}

export interface InfraDatacenter {
  code: string;
  name: string;
  city: string;
  nodes: InfraNode[];
}

export interface AdminUser {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  balance: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  actor: { id: number; email: string } | null;
  details: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}
