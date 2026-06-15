export interface Profile {
  id: string;
  email: string;
  role: "admin" | "super_admin" | "owner" | "tenant";
  name: string;
}

export interface Building {
  id: string;
  name: string;
  address: string;
  totalApartments: number;
}
