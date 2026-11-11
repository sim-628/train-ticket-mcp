export interface KVNamespace {
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface SecretBinding {
  get(): Promise<string>;
}

export interface Env {
  TRAIN_CACHE: KVNamespace;
  MCP_ACCESS_TOKEN: string;
  FIRECRAWL_KEY_1: SecretBinding | string;
  FIRECRAWL_KEY_2: SecretBinding | string;
  FIRECRAWL_KEY_3: SecretBinding | string;
  FIRECRAWL_KEY_4: SecretBinding | string;
  FIRECRAWL_KEY_5: SecretBinding | string;
  FIRECRAWL_KEY_6: SecretBinding | string;
}

export interface SeatOption {
  seat_type: string;
  availability: string;
  remaining_count: number | null;
}

export interface Train {
  train_number: string;
  departure_station: string;
  departure_time: string;
  arrival_station: string;
  arrival_time: string;
  arrival_date: string;
  duration: string;
  price: number;
  recommendation_tag: string | null;
  seat_options: SeatOption[];
}

export interface TrainQueryResult {
  success: true;
  query: {
    departure: string;
    arrival: string;
    date: string;
  };
  expected_count: number | null;
  parsed_count: number;
  is_complete: boolean;
  trains: Train[];
  source: {
    provider: "qunar";
    url: string;
    fetched_at: string;
  };
  cache: {
    hit: boolean;
    age_seconds: number;
  };
}
