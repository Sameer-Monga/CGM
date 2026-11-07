export interface ExtractedData {
  name?: string;
  phone_number?: string;
  emergency_phone_number?: string;
  gender?: string;
  date_of_birth?: string;
  age?: number;
  blood_group?: string;
  address?: string;
  permanent_address?: string;
  pincode?: number;
  state?: string;
  district?: string;
  local_body?: string;
  ward?: string;
}

export interface GovtOrg {
  id: string;
  name: string;
  has_children: boolean;
  metadata: { govt_org_type?: string; govt_org_children_type?: string } | null;
  parent?: GovtOrg;
}

export interface GovtOrgResponse {
  results: GovtOrg[];
}
