import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee } from "../lib/types";

// The real client needs the Supabase URL and key. Only the reorder RPC is called here.
const rpc = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase", () => ({ supabase: { rpc } }));

const { employeeErrorMessage, employeeReorderOptions } = await import("./employees");
const { invalidateAdminData } = await import("./adminKeys");

// Error bodies as PostgREST sent them for save_employee (local database, migration 004).
const errors = {
  duplicateName: { code: "23505", details: null, hint: null, message: "duplicate_name" },
  overlap: {
    code: "23P01",
    details: "Key conflicts with existing key.",
    hint: null,
    message: 'conflicting key value violates exclusion constraint "employee_rates_no_overlap"',
  },
  zeroRate: {
    code: "23514",
    details: null,
    hint: null,
    message: 'new row for relation "employee_rates" violates check constraint "employee_rates_rate_positive"',
  },
  badColor: {
    code: "23514",
    details: null,
    hint: null,
    message: 'new row for relation "employees" violates check constraint "employees_color_hex"',
  },
  endBeforeStart: {
    code: "23514",
    details: null,
    hint: null,
    message: 'new row for relation "employee_rates" violates check constraint "employee_rates_check"',
  },
  blankName: {
    code: "23514",
    details: null,
    hint: null,
    message: 'new row for relation "employees" violates check constraint "employees_name_check"',
  },
  notFound: { code: "P0002", details: null, hint: null, message: "not_found" },
  notAdmin: { code: "42501", details: null, hint: null, message: "not_admin" },
  network: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" },
  expired: { code: "PGRST303", details: null, hint: null, message: "JWT expired" },
  other: { code: "XX000", details: null, hint: null, message: "something else" },
};

describe("employeeErrorMessage", () => {
  it("explains database checks in the old page's words (EM §9)", () => {
    expect(employeeErrorMessage(errors.overlap, "save")).toBe("Rate periods cannot overlap. Please adjust the dates.");
    expect(employeeErrorMessage(errors.zeroRate, "save")).toBe("Hourly rate must be greater than 0 or left empty");
    expect(employeeErrorMessage(errors.endBeforeStart, "save")).toBe(
      "End date must be after start date for all rate periods",
    );
    expect(employeeErrorMessage(errors.blankName, "save")).toBe("Please enter an employee name");
    expect(employeeErrorMessage(errors.badColor, "save")).toBe("Pick a color.");
  });

  it("names the clash for a duplicate name when it knows the name (E4)", () => {
    expect(employeeErrorMessage(errors.duplicateName, "save", "Avery Lane")).toBe(
      "There's already an employee named Avery Lane.",
    );
    expect(employeeErrorMessage(errors.duplicateName, "save")).toBe("There's already an employee with that name.");
  });

  it("covers access, missing rows, the network and sign-in", () => {
    expect(employeeErrorMessage(errors.notAdmin, "archive")).toBe("Only admins can change employees.");
    expect(employeeErrorMessage(errors.notFound, "save")).toBe("This employee was already removed.");
    expect(employeeErrorMessage(errors.network, "reorder")).toBe(
      "Couldn't reach the schedule. Check your connection and try again.",
    );
    expect(employeeErrorMessage(errors.expired, "save")).toBe("Your sign-in has expired. Sign out, then sign in again.");
  });

  it("falls back per action", () => {
    expect(employeeErrorMessage(errors.other, "delete")).toBe("There was an error deleting this employee.");
    expect(employeeErrorMessage(errors.other, "save")).toBe("There was an error saving your changes.");
    expect(employeeErrorMessage(errors.other, "reorder")).toBe("There was an error saving your changes.");
    expect(employeeErrorMessage(new Error("boom"), "archive")).toBe("There was an error saving your changes.");
  });
});

describe("employeeReorderOptions", () => {
  const employee = (id: string, display_order: number): Employee => ({
    id,
    name: id,
    color: "#2B6CB0",
    display_order,
    archived: false,
  });
  const saved = [employee("a", 0), employee("b", 1), employee("c", 2)];

  let client: QueryClient;
  let unsubscribe: () => void;
  // What the database returns for the employee list, and how often the page asked.
  let serverList: Employee[];
  const fetchEmployees = vi.fn(async () => serverList);
  const fetchLogins = vi.fn(async () => new Set<string>());

  beforeEach(async () => {
    serverList = saved;
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    await client.prefetchQuery({ queryKey: ["employees"], queryFn: fetchEmployees });
    await client.prefetchQuery({ queryKey: ["employees", "logins"], queryFn: fetchLogins });
    // Mounted, like the drawer's lists, so an invalidation refetches them.
    const observers = [
      new QueryObserver(client, { queryKey: ["employees"], queryFn: fetchEmployees }),
      new QueryObserver(client, { queryKey: ["employees", "logins"], queryFn: fetchLogins }),
    ];
    const stops = observers.map((observer) => observer.subscribe(() => {}));
    unsubscribe = () => stops.forEach((stop) => stop());
    fetchEmployees.mockClear();
    fetchLogins.mockClear();
    rpc.mockReset();
  });

  afterEach(() => {
    unsubscribe();
    client.clear();
  });

  const order = () => client.getQueryData<Employee[]>(["employees"])?.map((e) => e.id);

  it("shows the new order at once, then refetches the list when it settles", async () => {
    let finish = (_value: { error: null }) => {};
    rpc.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const reorder = new MutationObserver(client, employeeReorderOptions(client));
    serverList = [employee("c", 0), employee("a", 1), employee("b", 2)];

    const done = reorder.mutate({ ids: ["c", "a", "b"] });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("set_employee_order", { p_ids: ["c", "a", "b"] }));
    expect(order()).toEqual(["c", "a", "b"]);
    // Another employee change settling now (an unarchive, say) leaves the optimistic list alone.
    await invalidateAdminData(client);
    expect(fetchEmployees).not.toHaveBeenCalled();

    finish({ error: null });
    await done;
    // The reorder still counts as running during its own onSettled; the list is refetched anyway.
    expect(fetchEmployees).toHaveBeenCalledTimes(1);
    expect(fetchLogins).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(["employees"])?.isInvalidated).toBe(false);
  });

  it("puts the saved order back after a failed reorder and checks it against the database", async () => {
    rpc.mockResolvedValue({ error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } });
    const reorder = new MutationObserver(client, employeeReorderOptions(client));
    const seen: (string[] | undefined)[] = [];
    const stop = client.getQueryCache().subscribe(() => seen.push(order()));

    await expect(reorder.mutate({ ids: ["b", "a", "c"] })).rejects.toThrow("Failed to fetch");
    stop();
    expect(seen).toContainEqual(["b", "a", "c"]);
    expect(order()).toEqual(["a", "b", "c"]);
    expect(fetchEmployees).toHaveBeenCalledTimes(1);
  });

  it("leaves the list alone until the last of several quick reorders settles", async () => {
    const finishers: ((value: { error: null }) => void)[] = [];
    rpc.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
    const reorder = new MutationObserver(client, employeeReorderOptions(client));

    const first = reorder.mutate({ ids: ["b", "a", "c"] });
    const last = reorder.mutate({ ids: ["b", "c", "a"] });
    await vi.waitFor(() => expect(finishers).toHaveLength(1));
    expect(order()).toEqual(["b", "c", "a"]);

    finishers[0]({ error: null });
    await first;
    // The second reorder's optimistic order stays on screen.
    expect(fetchEmployees).not.toHaveBeenCalled();
    expect(order()).toEqual(["b", "c", "a"]);

    await vi.waitFor(() => expect(finishers).toHaveLength(2));
    serverList = [employee("b", 0), employee("c", 1), employee("a", 2)];
    finishers[1]({ error: null });
    await last;
    expect(fetchEmployees).toHaveBeenCalledTimes(1);
    expect(order()).toEqual(["b", "c", "a"]);
  });
});
