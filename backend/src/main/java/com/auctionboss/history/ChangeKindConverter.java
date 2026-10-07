package com.auctionboss.history;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

@Converter
public class ChangeKindConverter implements AttributeConverter<ChangeKind, String> {

	@Override
	public String convertToDatabaseColumn(ChangeKind attribute) {
		return attribute == null ? null : attribute.dbValue();
	}

	@Override
	public ChangeKind convertToEntityAttribute(String dbData) {
		return dbData == null ? null : ChangeKind.fromDb(dbData);
	}

}
