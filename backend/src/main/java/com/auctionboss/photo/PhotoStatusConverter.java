package com.auctionboss.photo;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

@Converter
public class PhotoStatusConverter implements AttributeConverter<PhotoStatus, String> {

	@Override
	public String convertToDatabaseColumn(PhotoStatus attribute) {
		return attribute == null ? null : attribute.dbValue();
	}

	@Override
	public PhotoStatus convertToEntityAttribute(String dbData) {
		return dbData == null ? null : PhotoStatus.fromDb(dbData);
	}

}
