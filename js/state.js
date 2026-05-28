// Tiny stateless helpers that operate on parcel data.
// (Reserved for future expansion as a real state module.)

// sf_adm_de can be 0 even when the parcel has area — fall back to sf_adm_co in that case.
export function parcelArea(p) {
  return p.sf_adm_de > 0 ? p.sf_adm_de : p.sf_adm_co > 0 ? p.sf_adm_co : 0;
}

// Compute totals + per-crop breakdown from a Map of selected parcels.
export function aggregateParcels(selectedParcels) {
  let totalArea = 0;
  const byCrop = {};
  for (const [, p] of selectedParcels) {
    const a = parcelArea(p.props);
    totalArea += a;
    const k = p.props.code_cultu || "?";
    byCrop[k] = byCrop[k] || { count: 0, area: 0, category: p.props.cat_cult_p, bio: 0 };
    byCrop[k].count++;
    byCrop[k].area += a;
    if (p.props.bio === 1) byCrop[k].bio++;
  }
  return { totalArea, byCrop };
}
