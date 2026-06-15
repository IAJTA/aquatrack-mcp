export type Role = "super_admin" | "admin" | "owner" | "tenant";

export interface Profile {
  id: string;
  email: string;
  role: Role;
}

export interface Building {
  id: string;
  name: string;
  address: string;
  addressNumber?: string | null;
  addressReference?: string | null;
  department: string;
  municipality: string;
  totalApartments: number;
  floors?: number | null;
  adminId: string;
}

export interface Apartment {
  id: string;
  apartmentNumber: string;
  floor: number;
  roomsNumber: number | null;
  tenantsNumber: number | null;
  buildingId: string;
  ownerId: string | null;
  tenantId: string | null;
}

export interface Party {
  name: string;
  email: string;
}

export interface ApartmentWithRelations {
  apartment: Apartment;
  owner: Party | null;
  tenant: Party | null;
}

export interface WaterReading {
  latestReading: string;
  dailyConsumption: string;
}

export interface DailyConsumptionPoint {
  date: string;
  consumption: number;
}

export interface BuildingDailyConsumption {
  date: string;
  consumption: number;
}

export interface BuildingDailyChange {
  changePercentage: number;
}

export interface BuildingMonthlyConsumption {
  id: string;
  buildingId: string;
  month: string;
  payment: number;
  consumption: number;
  avgDailyUsage: number;
  peakDayUsage: number;
  createdAt: string;
  updatedAt: string;
}

export interface TopConsumer {
  apartmentId: string;
  apartmentNumber: string;
  username: string;
  totalConsumption: number;
}

export interface Central {
  id: number;
  installationDate?: string | null;
  isActive: boolean;
  wifiSsid?: string | null;
  macAddress?: string | null;
  buildingId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface WaterMeter {
  id: string;
  installationDate?: string | null;
  isActive: boolean;
  battery: string | number;
  macAddress?: string | null;
  apartmentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}