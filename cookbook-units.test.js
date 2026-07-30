// cookbook-units.test.js — run with: node cookbook-units.test.js
//
// No test framework on purpose: this project has no build step and no node_modules, and the whole
// point of the scaling engine is that it stays verifiable with the tools already on the machine.
const U = require("./cookbook-units.js");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}
function section(name) { console.log(`\n${name}`); }

// --- fraction formatting ----------------------------------------------------
section("formatQty");
eq(U.formatQty(1.5), "1½", "1.5 -> 1½");
eq(U.formatQty(0.5), "½", "0.5 -> ½");
eq(U.formatQty(1/3), "⅓", "0.333 -> ⅓");
eq(U.formatQty(2/3), "⅔", "0.667 -> ⅔");
eq(U.formatQty(0.25), "¼", "0.25 -> ¼");
eq(U.formatQty(2), "2", "2 -> 2");
eq(U.formatQty(0.375), "⅜", "0.375 -> ⅜");
eq(U.formatQty(2.4), "2.4", "2.4 -> decimal fallback");

// --- quantity parsing -------------------------------------------------------
section("parseQty");
eq(U.parseQty("1 1/2"), 1.5, "mixed number");
eq(U.parseQty("1/2"), 0.5, "simple fraction");
eq(U.parseQty("½"), 0.5, "unicode fraction");
eq(U.parseQty("1½"), 1.5, "whole + unicode fraction");
eq(U.parseQty("0.5"), 0.5, "decimal");
eq(U.parseQty("2"), 2, "integer");

// --- ingredient parsing -----------------------------------------------------
section("parseIngredient");
let i = U.parseIngredient("2 1/2 cups plain flour, sifted");
eq([i.qty, i.unit, i.item, i.note], [2.5, "cup", "plain flour", "sifted"], "full line with note");

i = U.parseIngredient("1½ cups milk");
eq([i.qty, i.unit, i.item], [1.5, "cup", "milk"], "unicode fraction + unit");

i = U.parseIngredient("2-3 tbsp olive oil");
eq([i.qty, i.qtyMax, i.unit, i.item], [2, 3, "tbsp", "olive oil"], "range");

i = U.parseIngredient("3 eggs");
eq([i.qty, i.unit, i.item], [3, "", "eggs"], "count, no unit");

i = U.parseIngredient("200g butter");
eq([i.qty, i.unit, i.item], [200, "g", "butter"], "no space before unit");

i = U.parseIngredient("2 cups of flour");
eq([i.qty, i.unit, i.item], [2, "cup", "flour"], '"of" stripped');

i = U.parseIngredient("pinch of salt");
eq([i.unit, i.scalable], ["pinch", false], "pinch does not scale");

i = U.parseIngredient("salt and pepper to taste");
eq(i.scalable, false, '"to taste" does not scale');

i = U.parseIngredient("olive oil, for greasing");
eq(i.scalable, false, '"for greasing" does not scale');

i = U.parseIngredient("1 T butter");
eq([i.qty, i.unit], [1, "tbsp"], "capital T = tablespoon");
i = U.parseIngredient("1 t vanilla");
eq([i.qty, i.unit], [1, "tsp"], "lowercase t = teaspoon");

i = U.parseIngredient("2 cloves garlic, crushed");
eq([i.qty, i.unit, i.item, i.note], [2, "clove", "garlic", "crushed"], "count unit + note");

i = U.parseIngredient("Plain flour");
eq([i.qty, i.item], [null, "Plain flour"], "no quantity at all");

// --- scaling ----------------------------------------------------------------
section("scaling");
const third = U.parseIngredient("1/3 cup sugar");
eq(U.formatIngredient(U.scaleIngredient(third, 3)), "1 cup sugar", "1/3 cup x3 = 1 cup");

const tbspRange = U.parseIngredient("2-3 tbsp cream");
eq(U.formatIngredient(U.scaleIngredient(tbspRange, 1.5)), "3–4½ tbsp cream", "range x1.5");

const egg = U.parseIngredient("1 egg");
eq(U.scaleIngredient(egg, 2.5).qty, 2.5, "1 egg x2.5 = 2.5 (halves allowed)");

const eggs = U.parseIngredient("2 eggs");
eq(U.scaleIngredient(eggs, 1.67).qty, 3.5, "2 eggs x1.67 rounds to 3.5, not 3.34");

const salt = U.parseIngredient("pinch of salt");
eq(U.scaleIngredient(salt, 4).qty, salt.qty, "pinch unchanged when scaled");

const flour = U.parseIngredient("137 g flour");
eq(U.scaleIngredient(flour, 1).qty, 137, "factor 1 is a no-op");
eq(U.roundForUnit(137, "g"), 140, "137 g rounds to 140");
eq(U.roundForUnit(18, "g"), 18, "18 g stays exact");
eq(U.roundForUnit(47, "g"), 45, "47 g rounds to 45");

// Scaling must not mutate the stored recipe.
const orig = U.parseIngredient("2 cups flour");
U.scaleIngredient(orig, 3);
eq(orig.qty, 2, "scaleIngredient does not mutate input");

// --- aggregation ------------------------------------------------------------
section("aggregation (metric / AU: 1 tbsp = 20 ml)");
let agg = U.aggregate([
  { item: "milk", qty: 3, unit: "tsp", fromRecipes: ["r1"] },
  { item: "milk", qty: 1, unit: "tbsp", fromRecipes: ["r2"] },
]);
eq(agg.length, 1, "tsp + tbsp merge to one line");
eq([agg[0].qty, agg[0].unit], [1.75, "tbsp"], "3 tsp + 1 tbsp = 35 ml = 1¾ tbsp (AU)");

agg = U.aggregate([
  { item: "onions, finely chopped", qty: 2, unit: "", fromRecipes: ["r1"] },
  { item: "onion", qty: 1, unit: "", fromRecipes: ["r2"] },
]);
eq(agg.length, 1, "'onions, finely chopped' and 'onion' merge");
eq(agg[0].qty, 3, "counts sum to 3");

agg = U.aggregate([
  { item: "butter", qty: 100, unit: "g", fromRecipes: ["r1"] },
  { item: "butter", qty: 1, unit: "cup", fromRecipes: ["r2"] },
]);
eq(agg.length, 2, "mass and volume of the same item stay separate (no density guess)");

agg = U.aggregate([
  { item: "flour", qty: 500, unit: "g", fromRecipes: ["r1"] },
  { item: "flour", qty: 700, unit: "g", fromRecipes: ["r2"] },
]);
eq([agg[0].qty, agg[0].unit], [1.2, "kg"], "1200 g promotes to 1.2 kg");
eq(agg[0].aisle, "Baking", "flour lands in the Baking aisle");
eq(agg[0].fromRecipes, ["r1", "r2"], "source recipes tracked");

// Dry goods measured in cups must stay in cups. 7.5 cups is 1875 ml, and reporting that as
// "1⅞ l of flour" is arithmetically right but useless — nobody buys flour by the litre.
agg = U.aggregate([
  { item: "flour", qty: 2.5, unit: "cup", fromRecipes: ["r1"] },
  { item: "flour", qty: 5, unit: "cup", fromRecipes: ["r2"] },
]);
eq([agg[0].qty, agg[0].unit], [7.5, "cup"], "cups stay cups, never promoted to litres");

// Millilitres do promote, because a big ml number genuinely reads worse.
agg = U.aggregate([
  { item: "stock", qty: 600, unit: "ml", fromRecipes: ["r1"] },
  { item: "stock", qty: 900, unit: "ml", fromRecipes: ["r2"] },
]);
eq([agg[0].qty, agg[0].unit], [1.5, "l"], "1500 ml promotes to 1.5 l");

// Mixed units report in the largest one actually used.
agg = U.aggregate([
  { item: "cream", qty: 1, unit: "cup", fromRecipes: ["r1"] },
  { item: "cream", qty: 2, unit: "tbsp", fromRecipes: ["r2"] },
]);
eq(agg[0].unit, "cup", "mixed cup+tbsp reports in cups");

// Aisle matching has to survive plurals.
eq(U.aisleFor("eggs"), "Dairy & Eggs", "eggs (plural) -> Dairy & Eggs");
eq(U.aisleFor("egg"), "Dairy & Eggs", "egg (singular) -> Dairy & Eggs");
eq(U.aisleFor("carrots"), "Produce", "carrots -> Produce");
eq(U.aisleFor("bread rolls"), "Bakery", "bread rolls -> Bakery");
eq(U.aisleFor("chicken thighs"), "Meat & Fish", "chicken thighs -> Meat & Fish");
eq(U.aisleFor("gold leaf"), "Other", "unknown item -> Other");

// --- US system --------------------------------------------------------------
section("US system (1 tbsp = 15 ml)");
U.setSystem("us");
agg = U.aggregate([
  { item: "milk", qty: 3, unit: "tsp", fromRecipes: ["r1"] },
  { item: "milk", qty: 1, unit: "tbsp", fromRecipes: ["r2"] },
]);
eq([agg[0].qty, agg[0].unit], [2, "tbsp"], "3 tsp + 1 tbsp = 30 ml = 2 tbsp (US)");
U.setSystem("metric");

// --- end-to-end shopping list ----------------------------------------------
section("buildShoppingList");
const list = U.buildShoppingList([
  {
    servings: 8,   // doubling a 4-serve recipe
    recipe: {
      id: "rec1", servings: 4,
      ingredients: [
        U.parseIngredient("200 g flour"),
        U.parseIngredient("pinch of salt"),
        U.parseIngredient("2 eggs"),
      ],
    },
  },
  {
    servings: 4,
    recipe: {
      id: "rec2", servings: 4,
      ingredients: [U.parseIngredient("100 g flour")],
    },
  },
]);
const flourLine = list.find((l) => l.name.includes("flour"));
eq(flourLine.qty, 500, "200g doubled + 100g = 500 g flour");
// "pinch of salt" carries no number, so it reaches the shopping list as a quantityless line —
// correct, because you buy salt, not "2 pinches" of it.
const saltLine = list.find((l) => l.name.includes("salt"));
eq(saltLine.qty, null, "pinch of salt has no shopping quantity");
const eggLine = list.find((l) => l.name.includes("egg"));
eq(eggLine.qty, 4, "2 eggs doubled = 4");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
