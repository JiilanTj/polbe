import { describe, expect, it } from "bun:test";

/**
 * Simulasi Logika Payout 70/30:
 * - 70% losing pool menjadi prize for winner, dibagi rata per user pemenang.
 * - Winning bet/modal pemenang dikembalikan.
 * - 30% losing pool menjadi prize for admin/system.
 * - Referrer biasa mendapat 3% dari losing wager downline.
 * - Referrer master mendapat 6% dari losing wager downline.
 */
function calculatePayout(winningWageredAmount: number, winnerCount: number, totalLosersWagered: number) {
  const prizeForWinner = totalLosersWagered * 0.7;
  const prizeForSystem = totalLosersWagered * 0.3;
  const bonus = winnerCount > 0 ? prizeForWinner / winnerCount : 0;
  const totalPayout = winningWageredAmount + bonus;

  return {
    prizeForWinner,
    prizeForSystem,
    bonus,
    totalPayout,
    roiPercent: winningWageredAmount > 0 ? (bonus / winningWageredAmount) * 100 : 0
  };
}

function calculateReferralPollCommission(losingWageredAmount: number, isMaster: boolean, livesToUsdtRate = 1) {
  const commissionRate = 0.03 + (isMaster ? 0.03 : 0);
  const commissionLives = losingWageredAmount * commissionRate;
  const remainingSystemPrizeLives = losingWageredAmount * (0.3 - commissionRate);
  return {
    commissionLives,
    commissionRate,
    remainingSystemPrizeLives,
    commissionUsdt: commissionLives * livesToUsdtRate,
  };
}

describe("Polymarket 70/30 Payout Logic", () => {
  
  it("membagi 70% losing pool rata per user pemenang dan mengembalikan modal", () => {
    const result = calculatePayout(10, 2, 100);

    expect(result.prizeForWinner).toBe(70);
    expect(result.prizeForSystem).toBe(30);
    expect(result.bonus).toBe(35);
    expect(result.totalPayout).toBe(45);
    expect(result.roiPercent).toBe(350);
  });

  it("winner dengan modal lebih besar tetap hanya mendapat bonus rata per user", () => {
    const smallWinner = calculatePayout(10, 2, 100);
    const bigWinner = calculatePayout(50, 2, 100);

    expect(smallWinner.bonus).toBe(35);
    expect(smallWinner.totalPayout).toBe(45);
    expect(bigWinner.bonus).toBe(35);
    expect(bigWinner.totalPayout).toBe(85);
  });

  it("membagi prize for winner dari semua loser", () => {
    const result = calculatePayout(1, 50, 100);

    expect(result.prizeForWinner).toBe(70);
    expect(result.bonus).toBe(1.4);
    expect(result.totalPayout).toBe(2.4);
  });

  it("hanya refund modal kalau tidak ada loser", () => {
    const result = calculatePayout(10, 5, 0);

    expect(result.bonus).toBe(0);
    expect(result.totalPayout).toBe(10);
  });

  it("menghitung komisi poll referral user biasa dari losing wager downline", () => {
    const result = calculateReferralPollCommission(100, false, 1);

    expect(result.commissionRate).toBe(0.03);
    expect(result.commissionLives).toBe(3);
    expect(result.commissionUsdt).toBe(3);
    expect(result.remainingSystemPrizeLives).toBe(27);
  });

  it("menghitung komisi poll referral master sebesar 6%", () => {
    const result = calculateReferralPollCommission(100, true, 1);

    expect(result.commissionRate).toBe(0.06);
    expect(result.commissionLives).toBe(6);
    expect(result.commissionUsdt).toBe(6);
    expect(result.remainingSystemPrizeLives).toBe(24);
  });

  it("mengonversi komisi referral poll ke USDT dengan platform rate", () => {
    const result = calculateReferralPollCommission(150, false, 0.5);

    expect(result.commissionLives).toBe(4.5);
    expect(result.commissionUsdt).toBe(2.25);
    expect(result.remainingSystemPrizeLives).toBe(40.5);
  });
});
