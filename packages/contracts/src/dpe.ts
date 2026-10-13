import { z } from 'zod';
import { EnergyClass, LocationPrecision } from './listing.ts';

/**
 * Diagnostic de performance énergétique (DPE) normalisé. Objet distinct d'une annonce :
 * le rapprochement DPE ↔ annonce viendra au chantier 3. Valeur inconnue = null.
 */
export const DpeBuildingType = z.enum(['apartment', 'house', 'building']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const NormalizedDpe = z
  .object({
    sourceId: z.string().min(1),
    dpeNumber: z.string().regex(/^[0-9A-Z]{13}$/),
    /** DPE que celui-ci remplace (correction ou refonte du diagnostic). */
    replacesDpeNumber: z.string().nullable(),
    /** DPE collectif de l'immeuble auquel ce DPE de logement est rattaché. */
    buildingDpeNumber: z.string().nullable(),
    dpeModel: z.string().nullable(),
    method: z.string().nullable(),
    buildingType: DpeBuildingType.nullable(),
    livingArea: z.number().positive().nullable(),
    energyClass: EnergyClass.nullable(),
    /** kWh d'énergie primaire / m² / an (5 usages). */
    energyValue: z.number().nonnegative().nullable(),
    gesClass: EnergyClass.nullable(),
    /** kg CO2e / m² / an (5 usages). */
    gesValue: z.number().nonnegative().nullable(),
    constructionYear: z.number().int().min(1000).max(2100).nullable(),
    constructionPeriod: z.string().nullable(),
    floor: z.number().int().nullable(),
    visitedAt: isoDate.nullable(),
    establishedAt: isoDate.nullable(),
    receivedAt: isoDate.nullable(),
    lastModifiedAt: isoDate.nullable(),
    validUntil: isoDate.nullable(),
    addressBan: z.string().nullable(),
    addressRaw: z.string().nullable(),
    addressComplement: z.string().nullable(),
    postalCode: z.string().regex(/^\d{5}$/).nullable(),
    /** Code postal saisi par le diagnostiqueur, avant géocodage. */
    rawPostalCode: z.string().regex(/^\d{5}$/).nullable(),
    inseeCode: z.string().regex(/^[0-9AB]{5}$/).nullable(),
    city: z.string().nullable(),
    banId: z.string().nullable(),
    banScore: z.number().min(0).max(1).nullable(),
    geocodingStatus: z.string().nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    locationPrecision: LocationPrecision.nullable(),
    rnbId: z.string().nullable(),
  })
  .strict();
export type NormalizedDpe = z.infer<typeof NormalizedDpe>;

export const DPE_CONTENT_FIELDS = Object.keys(NormalizedDpe.shape).filter(
  (k) => k !== 'sourceId' && k !== 'dpeNumber',
) as (keyof NormalizedDpe)[];
