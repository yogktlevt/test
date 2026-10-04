'use strict';

/**
 * Ends the active session when the machine is running on battery at or below
 * a cutoff percentage, so a forgotten session cannot drain a laptop flat.
 */
class BatteryGuard {
  /**
   * @param {object} deps
   * @param {import('./session').SessionManager} deps.session
   * @param {() => Promise<{hasBattery:boolean,onBattery:boolean,percent:number|null}>} deps.getBattery
   * @param {() => number} deps.getCutoff  percent; 0 disables the guard
   */
  constructor({ session, getBattery, getCutoff }) {
    this._session = session;
    this._getBattery = getBattery;
    this._getCutoff = getCutoff;
  }

  /** @returns {Promise<boolean>} true if it ended the session */
  async tick() {
    const cutoff = this._getCutoff();
    if (!cutoff || !this._session.active) return false; // avoid probing when nothing to guard
    const info = await this._getBattery();
    if (!this._session.active) return false; // ended while we were probing
    if (info.hasBattery && info.onBattery && info.percent !== null && info.percent <= cutoff) {
      this._session.stop('battery');
      return true;
    }
    return false;
  }
}

module.exports = { BatteryGuard };
