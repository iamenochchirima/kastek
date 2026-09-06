import {
  getCountries,
  getCountryCallingCode,
  type CountryCode,
} from "libphonenumber-js";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const stableCountryNames: Partial<Record<CountryCode, string>> = {
  FK: "Falkland Islands",
  HK: "Hong Kong SAR China",
  MO: "Macao SAR China",
  PS: "Palestinian Territories",
};

function countrySortKey(name: string) {
  return name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export const phoneCountries = getCountries()
  .map((code) => ({
    code,
    name: stableCountryNames[code] ?? regionNames.of(code) ?? code,
    callingCode: getCountryCallingCode(code),
  }))
  .sort((left, right) => {
    const leftKey = countrySortKey(left.name);
    const rightKey = countrySortKey(right.name);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  });
