package invalid.example;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.stereotype.Service;

@Service
public class WeatherService {
    @Tool(name = "city_temperature", description = "Returns the current temperature of a city in Celsius.")
    public double cityTemperature(String city) {
        return 20.0;
    }

    @Tool(name = "city_humidity", description = "Returns the current relative humidity of a city.")
    public double cityHumidity(String city) {
        return 0.5;
    }
}
