// =============================================================
// Regiony. MVP: Polska (16 województw). Kody TERYT i NUTS 2 (wersja NUTS 2021).
// Mazowieckie ma w NUTS 2 dwa regiony: PL91 (Warszawski stołeczny) i PL92.
// Współrzędne stolic — przybliżone, używane tylko jako środek wyszukiwania.
// Inne kraje UE: dodaj wpisy (kod NUTS + nazwa), patrz README → "Kolejne kraje".
// =============================================================

export interface Region {
  country: string;
  code: string; // TERYT dla PL
  nuts2: string[];
  name: string; // nazwa w formie używanej w adresach: "małopolskie"
  capital: { name: string; lat: number; lng: number };
}

export const REGIONS: Region[] = [
  { country: "PL", code: "02", nuts2: ["PL51"], name: "dolnośląskie", capital: { name: "Wrocław", lat: 51.107, lng: 17.038 } },
  { country: "PL", code: "04", nuts2: ["PL61"], name: "kujawsko-pomorskie", capital: { name: "Bydgoszcz", lat: 53.123, lng: 18.008 } },
  { country: "PL", code: "06", nuts2: ["PL81"], name: "lubelskie", capital: { name: "Lublin", lat: 51.246, lng: 22.568 } },
  { country: "PL", code: "08", nuts2: ["PL43"], name: "lubuskie", capital: { name: "Gorzów Wielkopolski", lat: 52.731, lng: 15.24 } },
  { country: "PL", code: "10", nuts2: ["PL71"], name: "łódzkie", capital: { name: "Łódź", lat: 51.759, lng: 19.456 } },
  { country: "PL", code: "12", nuts2: ["PL21"], name: "małopolskie", capital: { name: "Kraków", lat: 50.064, lng: 19.945 } },
  { country: "PL", code: "14", nuts2: ["PL91", "PL92"], name: "mazowieckie", capital: { name: "Warszawa", lat: 52.229, lng: 21.012 } },
  { country: "PL", code: "16", nuts2: ["PL52"], name: "opolskie", capital: { name: "Opole", lat: 50.675, lng: 17.921 } },
  { country: "PL", code: "18", nuts2: ["PL82"], name: "podkarpackie", capital: { name: "Rzeszów", lat: 50.041, lng: 21.999 } },
  { country: "PL", code: "20", nuts2: ["PL84"], name: "podlaskie", capital: { name: "Białystok", lat: 53.132, lng: 23.169 } },
  { country: "PL", code: "22", nuts2: ["PL63"], name: "pomorskie", capital: { name: "Gdańsk", lat: 54.352, lng: 18.646 } },
  { country: "PL", code: "24", nuts2: ["PL22"], name: "śląskie", capital: { name: "Katowice", lat: 50.264, lng: 19.023 } },
  { country: "PL", code: "26", nuts2: ["PL72"], name: "świętokrzyskie", capital: { name: "Kielce", lat: 50.866, lng: 20.628 } },
  { country: "PL", code: "28", nuts2: ["PL62"], name: "warmińsko-mazurskie", capital: { name: "Olsztyn", lat: 53.778, lng: 20.48 } },
  { country: "PL", code: "30", nuts2: ["PL41"], name: "wielkopolskie", capital: { name: "Poznań", lat: 52.406, lng: 16.925 } },
  { country: "PL", code: "32", nuts2: ["PL42"], name: "zachodniopomorskie", capital: { name: "Szczecin", lat: 53.428, lng: 14.553 } },
];

export function regionByCode(country: string, code: string): Region | undefined {
  return REGIONS.find((r) => r.country === country && r.code === code);
}
