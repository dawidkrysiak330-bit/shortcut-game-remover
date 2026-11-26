// Zaślepka biblioteki Excel dla podglądu online (tryb "artifact"), gdzie pobieranie plików nie działa.
export default {
  Workbook: class {
    constructor() { throw new Error("Eksport XLSX działa po uruchomieniu aplikacji u siebie (w podglądzie online pobieranie jest zablokowane)."); }
  },
};
