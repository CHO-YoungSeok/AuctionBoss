package com.auctionboss.worker;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

@Converter
public class RunOutcomeConverter implements AttributeConverter<RunOutcome, String> {

	@Override
	public String convertToDatabaseColumn(RunOutcome attribute) {
		return attribute == null ? null : attribute.dbValue();
	}

	@Override
	public RunOutcome convertToEntityAttribute(String dbData) {
		return dbData == null ? null : RunOutcome.fromDb(dbData);
	}

}
