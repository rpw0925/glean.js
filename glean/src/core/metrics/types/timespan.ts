/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CommonMetricData} from "../index.js";
import type { JSONValue } from "../../utils.js";
import TimeUnit from "../time_unit.js";
import { MetricType } from "../index.js";
import { isString, isObject, isNumber, isUndefined, getMonotonicNow } from "../../utils.js";
import { Metric } from "../metric.js";
import { Context } from "../../context.js";

export type TimespanInternalRepresentation = {
  // The time unit of the metric type at the time of recording.
  timeUnit: TimeUnit,
  // The timespan in milliseconds.
  timespan: number,
};
export class TimespanMetric extends Metric<TimespanInternalRepresentation, number> {
  constructor(v: unknown) {
    super(v);
  }

  validate(v: unknown): v is TimespanInternalRepresentation {
    if (!isObject(v) || Object.keys(v).length !== 2) {
      return false;
    }

    const timeUnitVerification = "timeUnit" in v && isString(v.timeUnit) && Object.values(TimeUnit).includes(v.timeUnit as TimeUnit);
    const timespanVerification = "timespan" in v && isNumber(v.timespan) && v.timespan >= 0;
    if (!timeUnitVerification || !timespanVerification) {
      return false;
    }

    return true;
  }

  payload(): number {
    switch(this._inner.timeUnit) {
    case TimeUnit.Nanosecond:
      return this._inner.timespan * 10**6;
    case TimeUnit.Microsecond:
      return this._inner.timespan * 10**3;
    case TimeUnit.Millisecond:
      return this._inner.timespan;
    case TimeUnit.Second:
      return Math.round(this._inner.timespan / 1000);
    case TimeUnit.Minute:
      return Math.round(this._inner.timespan / 1000 / 60);
    case TimeUnit.Hour:
      return Math.round(this._inner.timespan / 1000 / 60 / 60);
    case TimeUnit.Day:
      return Math.round(this._inner.timespan / 1000 / 60 / 60 / 24);
    }
  }
}

/**
 * A timespan metric.
 *
 * Timespans are used to make a measurement of how much time is spent in a particular task.
 */
class TimespanMetricType extends MetricType {
  private timeUnit: TimeUnit;
  startTime?: number;

  constructor(meta: CommonMetricData, timeUnit: string) {
    super("timespan", meta);
    this.timeUnit = timeUnit as TimeUnit;
  }

  /**
   * Starts tracking time for the provided metric.
   *
   * This records an error if it's already tracking time (i.e. start was
   * already called with no corresponding `stop()`. In which case the original
   * start time will be preserved.
   */
  start(): void {
    // Get the start time outside of the dispatched task so that
    // it is the time this function is called and not the time the task is executed.
    const startTime = getMonotonicNow();

    Context.dispatcher.launch(async () => {
      if (!this.shouldRecord(Context.uploadEnabled)) {
        return;
      }

      if (!isUndefined(this.startTime)) {
        // TODO: record error once Bug 1682574 is resolved.
        console.error("Timespan already started.");
        return;
      }

      this.startTime = startTime;

      return Promise.resolve();
    });
  }

  /**
   * Stops tracking time for the provided metric. Sets the metric to the elapsed time.
   *
   * This will record an error if no `start()` was called.
   */
  stop(): void {
    // Get the stop time outside of the dispatched task so that
    // it is the time this function is called and not the time the task is executed.
    const stopTime = getMonotonicNow();

    Context.dispatcher.launch(async () => {
      if (!this.shouldRecord(Context.uploadEnabled)) {
        // Reset timer when disabled, so that we don't record timespans across
        // disabled/enabled toggling.
        this.startTime = undefined;
        return;
      }

      if (isUndefined(this.startTime)) {
        // TODO: record error once Bug 1682574 is resolved.
        console.error("Timespan not running.");
        return;
      }

      const elapsed = stopTime - this.startTime;
      this.startTime = undefined;

      if (elapsed < 0) {
        // TODO: record error once Bug 1682574 is resolved.
        console.error("Timespan was negative.");
        return;
      }

      let reportValueExists = false;
      const transformFn = ((elapsed) => {
        return (old?: JSONValue): TimespanMetric => {
          let metric: TimespanMetric;
          try {
            metric = new TimespanMetric(old);
            // If creating the metric didn't error,
            // there is a valid timespan already recorded for this metric.
            reportValueExists = true;
          } catch {
            metric = new TimespanMetric({
              timespan: elapsed,
              timeUnit: this.timeUnit,
            });
          }

          return metric;
        };
      })(elapsed);

      await Context.metricsDatabase.transform(this, transformFn);

      if (reportValueExists) {
        // TODO: record error once Bug 1682574 is resolved.
        console.error("Timespan value already recorded. New value discarded.");
      }
    });
  }

  /**
   * Aborts a previous `start()` call.
   *
   * No error is recorded if no `start()` was called.
   */
  cancel(): void {
    Context.dispatcher.launch(() => {
      this.startTime = undefined;
      return Promise.resolve();
    });
  }

  /**
   * **Test-only API.**
   *
   * Gets the currently stored value as a number.
   *
   * This doesn't clear the stored value.
   *
   * TODO: Only allow this function to be called on test mode (depends on Bug 1682771).
   *
   * @param ping the ping from which we want to retrieve this metrics value from.
   *        Defaults to the first value in `sendInPings`.
   *
   * @returns The value found in storage or `undefined` if nothing was found.
   */
  async testGetValue(ping: string = this.sendInPings[0]): Promise<number | undefined> {
    let value: TimespanInternalRepresentation | undefined;
    await Context.dispatcher.testLaunch(async () => {
      value = await Context.metricsDatabase.getMetric<TimespanInternalRepresentation>(ping, this);
    });

    if (value) {
      // `payload` will truncate to the defined time_unit at the time of recording.
      return (new TimespanMetric(value)).payload();
    }
  }
}

export default TimespanMetricType;
