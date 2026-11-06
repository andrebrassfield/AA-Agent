import { describe, expect, it } from "bun:test";
import { FakeCalendar } from "../../src/calendar/calendar.ts";
import {
  buildSimConfig,
  buildSimGeocoder,
  localDayTime,
  runRouteSimulator,
  SIM_ADDRESSES,
  SIM_DAY,
  SIM_NOW,
  seedPackedDay,
} from "../../scripts/route-simulator.ts";
import { offerRouteAwareSlots } from "../../src/routing/offers.ts";

/**
 * Spec 2026-11-05 proof bar, end to end through the simulator:
 * a day with 3 stops in Fort Smith; a new caller in Greenwood vs a new caller
 * next door to stop 2. Ranked offers must put the near caller into the tight
 * gap and the far caller at the day's edge or the next day. Synthetic
 * addresses only; no live client data.
 */
describe("route-aware booking simulator (proof bar)", () => {
  it("runs all scenarios and satisfies the proof bar", async () => {
    const { scenarios } = await runRouteSimulator();
    expect(scenarios).toHaveLength(5);

    const near = scenarios[0];
    const far = scenarios[1];
    const outOfArea = scenarios[2];
    const packed = scenarios[3];
    const fallback = scenarios[4];

    // Near caller: tight gap, tiny added drive, exact-time plain-words offer
    expect(near.result.routeAware).toBe(true);
    expect(near.result.offers.length).toBeGreaterThan(0);
    const nearTop = localDayTime(near.result.offers[0].startTime);
    expect(nearTop.day).toBe(SIM_DAY);
    expect(nearTop.minutes).toBeGreaterThanOrEqual(10 * 60);
    expect(nearTop.minutes).toBeLessThan(11 * 60 + 30);
    expect(near.result.offers[0].addedDriveMinutes!).toBeLessThanOrEqual(5);
    expect(near.result.suggestedReply).toMatch(/^We can be there at \d/);

    // Far caller: day's edge or next day, much larger added drive
    expect(far.result.offers.length).toBeGreaterThan(0);
    const farTop = localDayTime(far.result.offers[0].startTime);
    expect(farTop.day === SIM_DAY ? farTop.minutes >= 15 * 60 : farTop.day === "2026-11-07").toBe(true);
    expect(far.result.offers[0].addedDriveMinutes!).toBeGreaterThan(25);
    expect(near.result.offers[0].addedDriveMinutes!).toBeLessThan(far.result.offers[0].addedDriveMinutes!);

    // Out of area: no offers, take a message
    expect(outOfArea.result.inServiceArea).toBe(false);
    expect(outOfArea.result.offers).toEqual([]);

    // Packed day: far caller pushed to the next open day
    expect(packed.result.offers[0]).toBeDefined();
    expect(localDayTime(packed.result.offers[0].startTime).day).toBe("2026-11-07");

    // Geocoder failure: fallback, no drive claims anywhere
    expect(fallback.result.routeAware).toBe(false);
    expect(fallback.result.offers.length).toBeGreaterThan(0);
    for (const o of fallback.result.offers) expect(o.addedDriveMinutes).toBeUndefined();
  });

  it("packed-day scenario offers only the next open day for the far caller", async () => {
    const config = buildSimConfig();
    const calendar = new FakeCalendar();
    await seedPackedDay(calendar);
    const res = await offerRouteAwareSlots(
      { serviceId: "in-home-visit", customerAddress: SIM_ADDRESSES.greenwoodCaller, day: SIM_DAY },
      config,
      calendar,
      buildSimGeocoder(),
      { now: SIM_NOW, syntheticAllowed: true }
    );
    expect(res.routeAware).toBe(true);
    expect(res.offers.length).toBeGreaterThan(0);
    for (const o of res.offers) {
      expect(localDayTime(o.startTime).day).toBe("2026-11-07");
    }
  });
});
