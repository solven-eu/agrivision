#!/usr/bin/env python3
"""Generate docs/impact-economique-template.xlsx — a data-collection + indicators workbook
for measuring AgriVision's economic/environmental impact (PIB, eau, engrais).

Pure standard library (zipfile + minimal OOXML), so it runs on any Python 3 with no deps.
Re-run after editing to regenerate the template:  python3 scripts/build-impact-xlsx.py
"""

import os
import zipfile

# ---- tiny OOXML helpers ----------------------------------------------------------------
def esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def colname(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

def S(v, style=0):   # string cell
    return {"t": "s", "v": v, "s": style}

def H(v):            # header (bold)
    return {"t": "s", "v": v, "s": 1}

def N(v, style=0):   # number cell
    return {"t": "n", "v": v, "s": style}

def F(v, style=0):   # formula cell
    return {"t": "f", "v": v, "s": style}

def cell_xml(col, row, spec):
    if spec is None:
        return ""
    ref = f"{colname(col)}{row}"
    sattr = f' s="{spec["s"]}"' if spec.get("s") else ""
    if spec["t"] == "n":
        return f'<c r="{ref}"{sattr}><v>{spec["v"]}</v></c>'
    if spec["t"] == "f":
        return f'<c r="{ref}"{sattr}><f>{esc(spec["v"])}</f></c>'
    return (f'<c r="{ref}"{sattr} t="inlineStr"><is>'
            f'<t xml:space="preserve">{esc(spec["v"])}</t></is></c>')

def sheet_xml(grid, dim, cols_xml=""):
    rows = []
    for ri, row in enumerate(grid, start=1):
        cells = "".join(cell_xml(ci, ri, spec) for ci, spec in enumerate(row, start=1))
        if cells:
            rows.append(f'<row r="{ri}">{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="{dim}"/>{cols_xml}'
        f'<sheetData>{"".join(rows)}</sheetData></worksheet>'
    )

# ---- Sheet 1: Hypothèses (editable parameters referenced by formulas) -------------------
hyp = [
    [H("Paramètre"), H("Valeur"), H("Unité"), H("Source / Note")],
    [S("Prix de l'eau d'irrigation"), N(0.50), S("€/m³"), S("À ajuster (tarif local Réunion)")],
    [S("Prix moyen des engrais (NPK)"), N(1.20), S("€/kg"), S("À ajuster")],
    [S("Multiplicateur valeur ajoutée → PIB"), N(1.0), S("ratio"),
     S("1 = on compte la valeur ajoutée brute, sans effet multiplicateur")],
    [S("Facteur CO₂ des engrais azotés"), N(5.5), S("kgCO₂e/kg"),
     S("Optionnel — pour l'indicateur carbone")],
]
hyp_cols = '<cols><col min="1" max="1" width="34"/><col min="2" max="2" width="12"/>' \
           '<col min="3" max="3" width="12"/><col min="4" max="4" width="48"/></cols>'

# ---- Sheet 2: Données (one row per parcelle/intervention) -------------------------------
DATA_HEADERS = [
    "Identifiant", "Date", "Région / Commune", "Utilisateur (anonymisé)", "Culture",
    "Surface (ha)", "Eau habituelle (m³)", "Eau avec AgriVision (m³)",
    "Engrais habituel (kg)", "Engrais avec AgriVision (kg)",
    "Rendement habituel (t/ha)", "Rendement avec AgriVision (t/ha)",
    "Prix de vente (€/t)", "Coût traitement évité (€)",
    "Eau économisée (m³)", "Eau économisée (€)", "Engrais économisé (kg)",
    "Engrais économisé (€)", "Gain de rendement (t)", "Valeur additionnelle (€)",
    "CO₂ évité (kgCO₂e)", "Notes",
]
# columns A..N are inputs; O..U are computed; V is free text.
EXAMPLES = [
    ["EX-001", "2026-01-15", "Saint-Pierre", "U001", "Canne à sucre", 2.5, 4500, 3900, 600, 480, 85, 90, 45, 120],
    ["EX-002", "2026-01-20", "Saint-Joseph", "U002", "Banane", 1.2, 3000, 2600, 350, 290, 30, 33, 600, 80],
    ["EX-003", "2026-02-03", "Le Tampon", "U003", "Maraîchage (tomate)", 0.5, 1800, 1450, 180, 140, 60, 66, 900, 200],
    ["EX-004", "2026-02-10", "Saint-Paul", "U004", "Agrumes", 1.8, 2700, 2400, 420, 360, 22, 24, 700, 90],
    ["EX-005", "2026-02-22", "Saint-Benoît", "U005", "Canne à sucre", 3.0, 5400, 4700, 720, 600, 80, 84, 45, 150],
    ["EX-006", "2026-03-05", "Sainte-Marie", "U006", "Ananas", 0.8, 2200, 1900, 240, 200, 50, 54, 800, 60],
]
LAST_DATA_ROW = 60  # formulas pre-filled down to here, ready for new data

def data_formulas(r):
    # guard on Identifiant (col A) so empty rows stay blank instead of showing 0.
    g = f'$A{r}=""'
    return [
        F(f'=IF({g},"",G{r}-H{r})'),                          # O Eau économisée (m³)
        F(f"=IF({g},\"\",O{r}*'Hypothèses'!$B$2)"),           # P Eau économisée (€)
        F(f'=IF({g},"",I{r}-J{r})'),                          # Q Engrais économisé (kg)
        F(f"=IF({g},\"\",Q{r}*'Hypothèses'!$B$3)"),           # R Engrais économisé (€)
        F(f'=IF({g},"",(L{r}-K{r})*F{r})'),                   # S Gain de rendement (t)
        F(f'=IF({g},"",S{r}*M{r}+N{r})'),                     # T Valeur additionnelle (€)
        F(f"=IF({g},\"\",Q{r}*'Hypothèses'!$B$5)"),           # U CO₂ évité
    ]

data = [[H(h) for h in DATA_HEADERS]]
for i in range(LAST_DATA_ROW - 1):
    r = i + 2
    inputs = EXAMPLES[i] if i < len(EXAMPLES) else []
    row = []
    for c in range(14):  # A..N
        if c < len(inputs):
            v = inputs[c]
            row.append(N(v) if isinstance(v, (int, float)) else S(v))
        else:
            row.append(None)
    row += data_formulas(r)      # O..U
    row.append(None)             # V Notes
    data.append(row)
data_cols = '<cols><col min="1" max="22" width="17"/></cols>'

# ---- Sheet 3: Indicateurs (auto-aggregating dashboard) ---------------------------------
# Aggregate well past the pre-filled rows so new data is included. Range must repeat the
# column on both sides: O2:O1000 (NOT O2:1000).
def col_rng(c):
    return f"'Données'!{c}2:{c}1000"

ind = [
    [H("Indicateur"), H("Valeur"), H("Unité")],
    [S("Parcelles suivies"), F(f"=COUNTA({col_rng('A')})"), S("parcelles")],
    [S("Surface totale"), F(f"=SUM({col_rng('F')})"), S("ha")],
    [S("Eau économisée"), F(f"=SUM({col_rng('O')})"), S("m³")],
    [S("Valeur de l'eau économisée"), F(f"=SUM({col_rng('P')})"), S("€")],
    [S("Engrais économisé"), F(f"=SUM({col_rng('Q')})"), S("kg")],
    [S("Valeur de l'engrais économisé"), F(f"=SUM({col_rng('R')})"), S("€")],
    [S("Gain de rendement"), F(f"=SUM({col_rng('S')})"), S("t")],
    [S("Valeur additionnelle créée"), F(f"=SUM({col_rng('T')})"), S("€")],
    [S("Contribution estimée au PIB"), F("=B9*'Hypothèses'!$B$4"), S("€")],
    [S("Économies d'intrants (eau + engrais)"), F("=B5+B7"), S("€")],
    [S("CO₂ évité (engrais)"), F(f"=SUM({col_rng('U')})"), S("kgCO₂e")],
]
ind_cols = '<cols><col min="1" max="1" width="38"/><col min="2" max="2" width="16"/>' \
           '<col min="3" max="3" width="12"/></cols>'

# ---- Sheet 4: Méthodologie -------------------------------------------------------------
method_lines = [
    "AgriVision — Modèle d'impact économique & environnemental",
    "",
    "OBJET",
    "Collecter des observations de terrain et en dériver des indicateurs d'impact :",
    "valeur additionnelle créée (proxy de contribution au PIB), eau économisée, engrais économisé, CO₂ évité.",
    "",
    "COMMENT L'UTILISER",
    "1) Onglet « Hypothèses » : ajuster les prix unitaires et facteurs (cellules en colonne B).",
    "2) Onglet « Données » : une ligne par parcelle/intervention. Remplir les colonnes A→N.",
    "   Les colonnes O→U se calculent automatiquement (formules déjà copiées jusqu'à la ligne 60 ;",
    "   copier les formules vers le bas si besoin de plus de lignes).",
    "3) Onglet « Indicateurs » : totaux mis à jour automatiquement.",
    "",
    "DÉFINITION DES COLONNES (onglet Données)",
    "Eau / Engrais « habituel » = pratique de référence du producteur (sans AgriVision).",
    "Eau / Engrais « avec AgriVision » = consommation effective après recommandation.",
    "Eau économisée (m³) = habituel − avec AgriVision.  Valeur (€) = m³ × prix de l'eau.",
    "Engrais économisé (kg) = habituel − avec AgriVision.  Valeur (€) = kg × prix engrais.",
    "Gain de rendement (t) = (rendement avec − rendement habituel) × surface.",
    "Valeur additionnelle (€) = gain de rendement × prix de vente + coût de traitement évité.",
    "Coût traitement évité (€) = intrants/main-d'œuvre d'un traitement jugé inutile par le diagnostic.",
    "",
    "HYPOTHÈSE PIB",
    "Contribution estimée au PIB = valeur additionnelle totale × multiplicateur (Hypothèses!B4).",
    "Par défaut le multiplicateur vaut 1 : on assimile la contribution à la valeur ajoutée brute créée.",
    "",
    "LIMITES & PRÉCAUTIONS",
    "• Données déclaratives : à valider/recouper (échantillon, témoins, mesures réelles si possible).",
    "• Ne pas double-compter une même parcelle sur plusieurs lignes pour la même saison.",
    "• L'impact « PIB » est une estimation de valeur ajoutée, pas un calcul macro-économique officiel.",
    "• RGPD : la colonne « Utilisateur » doit être anonymisée (identifiant, pas de nom/e-mail).",
    "• Les lignes EX-00x sont des EXEMPLES — les supprimer avant de saisir des données réelles.",
]
method = [[S(line)] for line in method_lines]
method[0] = [H(method_lines[0])]
method_cols = '<cols><col min="1" max="1" width="115"/></cols>'

# ---- assemble package ------------------------------------------------------------------
SHEETS = [
    ("Hypothèses", sheet_xml(hyp, "A1:D5", hyp_cols)),
    ("Données", sheet_xml(data, f"A1:V{LAST_DATA_ROW}", data_cols)),
    ("Indicateurs", sheet_xml(ind, "A1:C12", ind_cols)),
    ("Méthodologie", sheet_xml(method, f"A1:A{len(method)}", method_cols)),
]

content_types = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + "".join(
        f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(len(SHEETS))
    )
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + "</Types>"
)

root_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)

wb_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + "".join(
        f'<Relationship Id="rId{i+1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{i+1}.xml"/>'
        for i in range(len(SHEETS))
    )
    + f'<Relationship Id="rId{len(SHEETS)+1}" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + "</Relationships>"
)

workbook = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets>'
    + "".join(
        f'<sheet name="{esc(name)}" sheetId="{i+1}" r:id="rId{i+1}"/>'
        for i, (name, _) in enumerate(SHEETS)
    )
    + '</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>'
)

styles = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    '<fills count="2"><fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="2">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '</cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    '</styleSheet>'
)

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "impact-economique-template.xlsx")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", root_rels)
    z.writestr("xl/workbook.xml", workbook)
    z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
    z.writestr("xl/styles.xml", styles)
    for i, (_, xml) in enumerate(SHEETS):
        z.writestr(f"xl/worksheets/sheet{i+1}.xml", xml)

print("wrote", os.path.normpath(OUT))
