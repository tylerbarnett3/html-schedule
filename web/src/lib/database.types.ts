export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      admins: {
        Row: {
          created_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      availability: {
        Row: {
          available_date: string;
          created_at: string;
          employee_id: string;
          id: string;
          period: Database["public"]["Enums"]["day_period"];
          requested_at: string;
          requested_by: string | null;
          reviewed_at: string | null;
          status: Database["public"]["Enums"]["request_status"];
          updated_at: string;
          wix_id: string | null;
        };
        Insert: {
          available_date: string;
          created_at?: string;
          employee_id: string;
          id?: string;
          period?: Database["public"]["Enums"]["day_period"];
          requested_at?: string;
          requested_by?: string | null;
          reviewed_at?: string | null;
          status?: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          wix_id?: string | null;
        };
        Update: {
          available_date?: string;
          created_at?: string;
          employee_id?: string;
          id?: string;
          period?: Database["public"]["Enums"]["day_period"];
          requested_at?: string;
          requested_by?: string | null;
          reviewed_at?: string | null;
          status?: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          wix_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "availability_employee_id_fkey";
            columns: ["employee_id"];
            isOneToOne: false;
            referencedRelation: "employees";
            referencedColumns: ["id"];
          },
        ];
      };
      closed_days: {
        Row: {
          closed_date: string;
          created_at: string;
        };
        Insert: {
          closed_date: string;
          created_at?: string;
        };
        Update: {
          closed_date?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      custom_hours: {
        Row: {
          close_time: string;
          created_at: string;
          hours_date: string;
          open_time: string;
          updated_at: string;
        };
        Insert: {
          close_time: string;
          created_at?: string;
          hours_date: string;
          open_time: string;
          updated_at?: string;
        };
        Update: {
          close_time?: string;
          created_at?: string;
          hours_date?: string;
          open_time?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      employee_rates: {
        Row: {
          created_at: string;
          employee_id: string;
          end_date: string | null;
          id: string;
          rate: number;
          start_date: string | null;
          updated_at: string;
          wix_id: string | null;
        };
        Insert: {
          created_at?: string;
          employee_id: string;
          end_date?: string | null;
          id?: string;
          rate: number;
          start_date?: string | null;
          updated_at?: string;
          wix_id?: string | null;
        };
        Update: {
          created_at?: string;
          employee_id?: string;
          end_date?: string | null;
          id?: string;
          rate?: number;
          start_date?: string | null;
          updated_at?: string;
          wix_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "employee_rates_employee_id_fkey";
            columns: ["employee_id"];
            isOneToOne: false;
            referencedRelation: "employees";
            referencedColumns: ["id"];
          },
        ];
      };
      employees: {
        Row: {
          archived: boolean;
          color: string;
          created_at: string;
          display_order: number;
          id: string;
          name: string;
          updated_at: string;
          user_id: string | null;
          wix_id: string | null;
        };
        Insert: {
          archived?: boolean;
          color?: string;
          created_at?: string;
          display_order?: number;
          id?: string;
          name: string;
          updated_at?: string;
          user_id?: string | null;
          wix_id?: string | null;
        };
        Update: {
          archived?: boolean;
          color?: string;
          created_at?: string;
          display_order?: number;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string | null;
          wix_id?: string | null;
        };
        Relationships: [];
      };
      hour_logs: {
        Row: {
          created_at: string;
          employee_id: string;
          end_time: string;
          note: string;
          shift_id: string;
          start_time: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          employee_id: string;
          end_time: string;
          note?: string;
          shift_id: string;
          start_time: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          employee_id?: string;
          end_time?: string;
          note?: string;
          shift_id?: string;
          start_time?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "hour_logs_employee_id_fkey";
            columns: ["employee_id"];
            isOneToOne: false;
            referencedRelation: "employees";
            referencedColumns: ["id"];
          },
        ];
      };
      shift_actuals: {
        Row: {
          actualized_at: string;
          created_at: string;
          employee_id: string;
          end_time: string | null;
          id: string;
          note: string;
          shift_id: string | null;
          start_time: string | null;
          status: Database["public"]["Enums"]["actual_status"];
          updated_at: string;
          wix_id: string | null;
          work_date: string;
        };
        Insert: {
          actualized_at?: string;
          created_at?: string;
          employee_id: string;
          end_time?: string | null;
          id?: string;
          note?: string;
          shift_id?: string | null;
          start_time?: string | null;
          status: Database["public"]["Enums"]["actual_status"];
          updated_at?: string;
          wix_id?: string | null;
          work_date: string;
        };
        Update: {
          actualized_at?: string;
          created_at?: string;
          employee_id?: string;
          end_time?: string | null;
          id?: string;
          note?: string;
          shift_id?: string | null;
          start_time?: string | null;
          status?: Database["public"]["Enums"]["actual_status"];
          updated_at?: string;
          wix_id?: string | null;
          work_date?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_actuals_employee_id_fkey";
            columns: ["employee_id"];
            isOneToOne: false;
            referencedRelation: "employees";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shift_actuals_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: true;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
        ];
      };
      shifts: {
        Row: {
          created_at: string;
          employee_id: string;
          end_time: string;
          id: string;
          shift_date: string;
          start_time: string;
          updated_at: string;
          wix_id: string | null;
        };
        Insert: {
          created_at?: string;
          employee_id: string;
          end_time: string;
          id?: string;
          shift_date: string;
          start_time: string;
          updated_at?: string;
          wix_id?: string | null;
        };
        Update: {
          created_at?: string;
          employee_id?: string;
          end_time?: string;
          id?: string;
          shift_date?: string;
          start_time?: string;
          updated_at?: string;
          wix_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "shifts_employee_id_fkey";
            columns: ["employee_id"];
            isOneToOne: false;
            referencedRelation: "employees";
            referencedColumns: ["id"];
          },
        ];
      };
      time_off: {
        Row: {
          created_at: string;
          employee_id: string;
          id: string;
          off_date: string;
          period: Database["public"]["Enums"]["day_period"];
          requested_at: string;
          requested_by: string | null;
          reviewed_at: string | null;
          source: string;
          status: Database["public"]["Enums"]["request_status"];
          updated_at: string;
          wix_id: string | null;
        };
        Insert: {
          created_at?: string;
          employee_id: string;
          id?: string;
          off_date: string;
          period?: Database["public"]["Enums"]["day_period"];
          requested_at?: string;
          requested_by?: string | null;
          reviewed_at?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          wix_id?: string | null;
        };
        Update: {
          created_at?: string;
          employee_id?: string;
          id?: string;
          off_date?: string;
          period?: Database["public"]["Enums"]["day_period"];
          requested_at?: string;
          requested_by?: string | null;
          reviewed_at?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["request_status"];
          updated_at?: string;
          wix_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "time_off_employee_id_fkey";
            columns: ["employee_id"];
            isOneToOne: false;
            referencedRelation: "employees";
            referencedColumns: ["id"];
          },
        ];
      };
      weekly_hours: {
        Row: {
          close_time: string;
          created_at: string;
          id: string;
          open_time: string;
          starts_on: string | null;
          updated_at: string;
          weekday: number;
        };
        Insert: {
          close_time: string;
          created_at?: string;
          id?: string;
          open_time: string;
          starts_on?: string | null;
          updated_at?: string;
          weekday: number;
        };
        Update: {
          close_time?: string;
          created_at?: string;
          id?: string;
          open_time?: string;
          starts_on?: string | null;
          updated_at?: string;
          weekday?: number;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      admin_add_days_off: { Args: { p_days: Json; p_delete_shift_ids?: string[] }; Returns: Json };
      admin_add_shifts: { Args: { p_shifts: Json }; Returns: Json };
      admin_close_days: { Args: { p_dates: string[] }; Returns: Json };
      admin_convert_to_day_off: {
        Args: {
          p_delete_shift_ids?: string[];
          p_employee_id: string;
          p_off_date: string;
          p_period: Database["public"]["Enums"]["day_period"];
          p_shift_id: string;
        };
        Returns: Json;
      };
      admin_convert_to_shift: {
        Args: {
          p_employee_id: string;
          p_end_time: string;
          p_shift_date: string;
          p_start_time: string;
          p_time_off_id: string;
        };
        Returns: Json;
      };
      admin_delete_items: {
        Args: { p_shift_ids?: string[]; p_time_off_ids?: string[] };
        Returns: Json;
      };
      admin_set_custom_hours: {
        Args: { p_close_time: string; p_dates: string[]; p_open_time: string };
        Returns: Json;
      };
      admin_set_standard_hours: { Args: { p_dates: string[] }; Returns: Json };
      admin_undo: { Args: { p_change: Json }; Returns: undefined };
      admin_update_day_off: {
        Args: {
          p_delete_shift_ids?: string[];
          p_employee_id: string;
          p_id: string;
          p_off_date: string;
          p_period: Database["public"]["Enums"]["day_period"];
        };
        Returns: Json;
      };
      admin_update_shift: {
        Args: {
          p_employee_id: string;
          p_end_time: string;
          p_id: string;
          p_shift_date: string;
          p_start_time: string;
        };
        Returns: Json;
      };
      approve_availability: { Args: { p_ids: string[] }; Returns: Json };
      approve_time_off: { Args: { p_delete_shift_ids?: string[]; p_ids: string[] }; Returns: Json };
      assert_admin: { Args: Record<PropertyKey, never>; Returns: undefined };
      assert_open: { Args: { p_dates: string[] }; Returns: undefined };
      business_today: { Args: Record<PropertyKey, never>; Returns: string };
      capture_delete_shifts: { Args: { p_ids: string[] }; Returns: Json };
      check_request_date: { Args: { p_date: string; p_employee_id: string }; Returns: undefined };
      current_employee_id: { Args: Record<PropertyKey, never>; Returns: string };
      empty_change: { Args: Record<PropertyKey, never>; Returns: Json };
      hour_log_refusal: {
        Args: { p_employee_id: string; p_shift: Database["public"]["Tables"]["shifts"]["Row"] };
        Returns: string;
      };
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_staff: { Args: Record<PropertyKey, never>; Returns: boolean };
      lock_loggable_shift: { Args: { p_shift_id: string }; Returns: string };
      log_shift_hours: {
        Args: { p_end: string; p_note: string; p_shift_id: string; p_start: string };
        Returns: undefined;
      };
      my_loggable_shifts: {
        Args: Record<PropertyKey, never>;
        Returns: {
          end_time: string;
          logged_at: string;
          logged_end: string;
          logged_note: string;
          logged_start: string;
          shift_date: string;
          shift_id: string;
          start_time: string;
        }[];
      };
      periods_overlap: {
        Args: {
          a: Database["public"]["Enums"]["day_period"];
          b: Database["public"]["Enums"]["day_period"];
        };
        Returns: boolean;
      };
      remove_hour_log: { Args: { p_shift_id: string }; Returns: boolean };
      request_availability: {
        Args: { p_dates: string[]; p_period: Database["public"]["Enums"]["day_period"] };
        Returns: Json;
      };
      request_time_off: {
        Args: { p_dates: string[]; p_period: Database["public"]["Enums"]["day_period"] };
        Returns: Json;
      };
      save_employee: { Args: { p_employee: Json }; Returns: string };
      save_shift_actuals: { Args: { p_plan: Json }; Returns: Json };
      save_weekly_hours: { Args: { p_hours: Json }; Returns: undefined };
      set_employee_order: { Args: { p_ids: string[] }; Returns: undefined };
    };
    Enums: {
      actual_status: "confirmed" | "adjusted" | "not-worked" | "unscheduled";
      day_period: "full-day" | "morning" | "evening";
      request_status: "pending" | "approved";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      actual_status: ["confirmed", "adjusted", "not-worked", "unscheduled"],
      day_period: ["full-day", "morning", "evening"],
      request_status: ["pending", "approved"],
    },
  },
} as const;
